// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { organizations, projects, runs, usageEvents } from "../db/schema";
import type { Env } from "../types/env";
import {
  createPolarClient,
  getCustomerStateByExternalId,
  ingestUsageEvents,
} from "./polar";

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = "[billing]";
const POLAR_EVENT_NAME = "usage"; // Unified event name for Polar meter
const DEFAULT_PERIOD_DAYS = 30;
const RECENT_EVENTS_LIMIT = 10;
const MAX_POLAR_RETRIES = 3;
const POLAR_RETRY_DELAY_MS = 100;
const BATCH_SIZE = 50;

// ============================================================================
// Types
// ============================================================================

// Usage types for local tracking and Polar metadata
export type UsageType = "ai" | "sandbox";

// AI-specific usage data
interface AIUsageData {
  type: "ai";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

// Sandbox-specific usage data (for future E2B integration)
interface SandboxUsageData {
  type: "sandbox";
  durationMinutes: number;
  costUSD: number;
}

// Union type for all usage data
type UsageData = AIUsageData | SandboxUsageData;

interface BillingCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface UsageSummary {
  orgId: string;
  period: {
    start: string;
    end: string;
  };
  runs: {
    total: number;
    successful: number;
    failed: number;
  };
}

// ============================================================================
// Helpers
// ============================================================================

// Helper to retry Polar ingestion with exponential backoff
const retryPolarIngestion = async <T>(
  fn: () => Promise<T>,
  retries = MAX_POLAR_RETRIES
): Promise<T> => {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, POLAR_RETRY_DELAY_MS * 2 ** attempt)
        );
      }
    }
  }
  throw lastError;
};

// Build metadata for local storage based on usage type
const buildLocalMetadata = (
  usage: UsageData,
  runId?: string
): Record<string, unknown> => {
  if (usage.type === "ai") {
    return {
      runId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
      costUSD: usage.costUSD,
    };
  }
  // sandbox
  return {
    runId,
    durationMinutes: usage.durationMinutes,
    costUSD: usage.costUSD,
  };
};

// Build metadata for Polar (unified format with type discriminator)
const buildPolarMetadata = (
  usage: UsageData
): Record<string, string | number | boolean> => {
  const base = {
    type: usage.type,
    cost_usd: usage.costUSD,
  };

  if (usage.type === "ai") {
    return {
      ...base,
      model: usage.model,
      tokens: usage.inputTokens + usage.outputTokens,
    };
  }
  // sandbox
  return {
    ...base,
    duration_minutes: usage.durationMinutes,
  };
};

// Generic usage recording for both AI and sandbox
export const recordUsage = async (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: UsageData,
  byok: boolean
): Promise<void> => {
  // BYOK only applies to AI usage
  if (byok && usage.type === "ai") {
    return;
  }

  const { db, client } = await createDb(env);
  try {
    const eventId = crypto.randomUUID();
    await db.insert(usageEvents).values({
      id: eventId,
      organizationId: orgId,
      eventName: usage.type, // "ai" or "sandbox" for local breakdown
      metadata: buildLocalMetadata(usage, runId),
      polarIngested: false,
    });

    // Fire-and-forget Polar ingestion with retry - don't block the response
    const polar = createPolarClient(env);
    retryPolarIngestion(() =>
      ingestUsageEvents(polar, [
        {
          name: POLAR_EVENT_NAME, // Unified "usage" event for meter
          externalCustomerId: orgId,
          metadata: buildPolarMetadata(usage),
        },
      ])
    )
      .then(async () => {
        // Mark as ingested - use a fresh connection since this is fire-and-forget
        let freshClient: Awaited<ReturnType<typeof createDb>>["client"] | null =
          null;
        try {
          const result = await createDb(env);
          freshClient = result.client;
          await result.db
            .update(usageEvents)
            .set({ polarIngested: true })
            .where(eq(usageEvents.id, eventId));
        } finally {
          await freshClient?.end();
        }
      })
      .catch((error) => {
        // Structured log for log aggregators (Cloudflare Logpush, etc.)
        // Event persists locally with polarIngested=false for later retry via retryFailedPolarIngestions
        const errorType =
          error instanceof Error ? error.constructor.name : "UnknownError";
        console.error(
          JSON.stringify({
            level: "error",
            service: "billing",
            operation: "polar_ingestion",
            orgId,
            eventId,
            usageType: usage.type,
            errorType,
            message: error instanceof Error ? error.message : String(error),
            recoverable: true,
          })
        );

        // Track in Sentry for alerting on frequent failures
        Sentry.withScope((scope) => {
          scope.setTag("billing.operation", "polar_ingestion");
          scope.setTag("billing.org_id", orgId);
          scope.setTag("billing.usage_type", usage.type);
          scope.setTag("billing.recoverable", "true");
          scope.setLevel("warning");
          // Aggregate all ingestion failures together for systemic visibility
          scope.setFingerprint(["billing", "polar_ingestion_failure"]);
          scope.setContext("usage_event", {
            eventId,
            usageType: usage.type,
            costUSD: usage.costUSD,
          });
          Sentry.captureException(error);
        });
      });
  } finally {
    await client.end();
  }
};

// Convenience wrapper for AI usage (maintains backwards compatibility)
export const recordAIUsage = (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: Omit<AIUsageData, "type">,
  byok: boolean
): Promise<void> =>
  recordUsage(env, orgId, runId, { ...usage, type: "ai" }, byok);

// Convenience wrapper for sandbox usage
export const recordSandboxUsage = (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: Omit<SandboxUsageData, "type">
): Promise<void> =>
  recordUsage(env, orgId, runId, { ...usage, type: "sandbox" }, false);

export const canRunHeal = async (
  env: Env,
  orgId: string
): Promise<BillingCheckResult> => {
  // If Polar not configured, allow all (dev mode)
  if (!env.POLAR_ACCESS_TOKEN) {
    return { allowed: true };
  }

  const { db, client } = await createDb(env);
  try {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });

    if (!org) {
      return { allowed: false, reason: "Organization not found" };
    }

    // Check customer state in Polar for subscription/meter status
    const polar = createPolarClient(env);
    const customerState = await getCustomerStateByExternalId(polar, orgId);

    // Customer not found in Polar - not subscribed yet
    if (!customerState) {
      return {
        allowed: false,
        reason: "No active subscription. Please subscribe to use healing.",
      };
    }

    // Check for active subscription
    const hasActiveSubscription = customerState.activeSubscriptions.some(
      (sub) => sub.status === "active"
    );
    if (hasActiveSubscription) {
      return { allowed: true };
    }

    // Check meter balance (for metered/credit-based plans)
    const hasCredits = customerState.activeMeters.some(
      (meter) => meter.balance > 0
    );
    if (hasCredits) {
      return { allowed: true };
    }

    // No active subscription or credits
    return {
      allowed: false,
      reason: "No credits remaining. Please add more credits to continue.",
    };
  } catch (error) {
    // Log error but don't block on Polar API issues
    console.error(`${LOG_PREFIX} Failed to check billing status:`, error);

    // Alert on Polar API failures - fail-open allows unbilled usage during outages
    Sentry.withScope((scope) => {
      scope.setTag("billing.fail_open", "true");
      scope.setTag("billing.org_id", orgId);
      scope.setLevel("warning");
      // Aggregate all Polar outages together for visibility into systemic issues
      scope.setFingerprint(["billing", "polar_api_failure"]);
      Sentry.captureException(error);
    });

    // Fail open - allow healing if we can't reach Polar
    return { allowed: true };
  } finally {
    await client.end();
  }
};

// Credit usage summary with breakdown by type (AI vs sandbox)
export interface CreditUsageSummary {
  totalCostUSD: number;
  breakdown: {
    ai: { costUSD: number; percentage: number };
    sandbox: { costUSD: number; percentage: number };
  };
  eventCount: number;
  recentEvents: Array<{
    id: string;
    eventName: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>;
}

export const getCreditUsageSummary = async (
  env: Env,
  orgId: string
): Promise<CreditUsageSummary> => {
  const { db, client } = await createDb(env);
  try {
    // Use SQL aggregation with breakdown by event type
    const [aggregates, recentEvents] = await Promise.all([
      db
        .select({
          totalCostUSD: sql<number>`coalesce(sum((metadata->>'costUSD')::numeric), 0)`,
          aiCostUSD: sql<number>`coalesce(sum(
            case when event_name = 'ai' then (metadata->>'costUSD')::numeric else 0 end
          ), 0)`,
          sandboxCostUSD: sql<number>`coalesce(sum(
            case when event_name = 'sandbox' then (metadata->>'costUSD')::numeric else 0 end
          ), 0)`,
          eventCount: sql<number>`count(*)`,
        })
        .from(usageEvents)
        .where(eq(usageEvents.organizationId, orgId)),
      // Only fetch the 10 most recent events for display
      db.query.usageEvents.findMany({
        where: eq(usageEvents.organizationId, orgId),
        orderBy: (events, { desc }) => [desc(events.createdAt)],
        limit: RECENT_EVENTS_LIMIT,
      }),
    ]);

    const stats = aggregates[0] ?? {
      totalCostUSD: 0,
      aiCostUSD: 0,
      sandboxCostUSD: 0,
      eventCount: 0,
    };

    const total = Number(stats.totalCostUSD);
    const aiCost = Number(stats.aiCostUSD);
    const sandboxCost = Number(stats.sandboxCostUSD);

    return {
      totalCostUSD: total,
      breakdown: {
        ai: {
          costUSD: aiCost,
          percentage: total > 0 ? (aiCost / total) * 100 : 0,
        },
        sandbox: {
          costUSD: sandboxCost,
          percentage: total > 0 ? (sandboxCost / total) * 100 : 0,
        },
      },
      eventCount: Number(stats.eventCount),
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        eventName: e.eventName,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
    };
  } finally {
    await client.end();
  }
};

// Build Polar metadata from local event for retry
const buildRetryPolarMetadata = (
  eventName: string,
  metadata: Record<string, unknown>
): Record<string, string | number | boolean> => {
  const base = {
    type: eventName as UsageType,
    cost_usd: metadata.costUSD as number,
  };

  if (eventName === "ai") {
    return {
      ...base,
      model: (metadata.model as string) ?? "unknown",
      tokens:
        ((metadata.inputTokens as number) ?? 0) +
        ((metadata.outputTokens as number) ?? 0),
    };
  }
  // sandbox
  return {
    ...base,
    duration_minutes: (metadata.durationMinutes as number) ?? 0,
  };
};

// Retry failed Polar ingestions in batches (for scheduled job or manual trigger)
export const retryFailedPolarIngestions = async (
  env: Env,
  limit = BATCH_SIZE
): Promise<{ processed: number; succeeded: number; failed: number }> => {
  const { db, client } = await createDb(env);

  try {
    // Get failed events that haven't been ingested
    const failedEvents = await db.query.usageEvents.findMany({
      where: eq(usageEvents.polarIngested, false),
      orderBy: (events, { asc }) => [asc(events.createdAt)],
      limit,
    });

    if (failedEvents.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const polar = createPolarClient(env);
    const succeededIds: string[] = [];
    let failedCount = 0;

    // Batch events by organization for efficient ingestion
    const eventsByOrg = new Map<
      string,
      Array<{
        id: string;
        eventName: string;
        metadata: Record<string, unknown>;
      }>
    >();
    for (const event of failedEvents) {
      const orgEvents = eventsByOrg.get(event.organizationId) ?? [];
      orgEvents.push({
        id: event.id,
        eventName: event.eventName,
        metadata: event.metadata as Record<string, unknown>,
      });
      eventsByOrg.set(event.organizationId, orgEvents);
    }

    // Process each org's events as a batch
    for (const [orgId, events] of eventsByOrg) {
      try {
        await retryPolarIngestion(() =>
          ingestUsageEvents(
            polar,
            events.map((e) => ({
              name: POLAR_EVENT_NAME, // Unified "usage" event
              externalCustomerId: orgId,
              metadata: buildRetryPolarMetadata(e.eventName, e.metadata),
            }))
          )
        );
        succeededIds.push(...events.map((e) => e.id));
      } catch (error) {
        console.error(
          `${LOG_PREFIX} Failed to retry ingestion for org ${orgId}:`,
          error
        );
        failedCount += events.length;
      }
    }

    // Mark successfully ingested events
    if (succeededIds.length > 0) {
      await db
        .update(usageEvents)
        .set({ polarIngested: true })
        .where(inArray(usageEvents.id, succeededIds));
    }

    return {
      processed: failedEvents.length,
      succeeded: succeededIds.length,
      failed: failedCount,
    };
  } finally {
    await client.end();
  }
};

export const getUsageSummary = async (
  env: Env,
  orgId: string
): Promise<UsageSummary> => {
  const { db, client } = await createDb(env);

  try {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - DEFAULT_PERIOD_DAYS);
    const periodEnd = new Date();

    // First get project IDs for this org (single query, indexed lookup)
    const orgProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, orgId));

    const projectIds = orgProjects.map((p) => p.id);

    // Early return if no projects
    if (projectIds.length === 0) {
      return {
        orgId,
        period: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        runs: { total: 0, successful: 0, failed: 0 },
      };
    }

    // Use inArray with known project IDs instead of subquery
    const result = await db
      .select({
        total: sql<number>`count(*)`,
        successful: sql<number>`count(*) filter (where ${runs.conclusion} = 'success')`,
        failed: sql<number>`count(*) filter (where ${runs.conclusion} = 'failure')`,
      })
      .from(runs)
      .where(
        and(
          inArray(runs.projectId, projectIds),
          gte(runs.receivedAt, periodStart)
        )
      );

    const stats = result[0] ?? { total: 0, successful: 0, failed: 0 };

    return {
      orgId,
      period: {
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
      runs: {
        total: Number(stats.total),
        successful: Number(stats.successful),
        failed: Number(stats.failed),
      },
    };
  } finally {
    await client.end();
  }
};
