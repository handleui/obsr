// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { getConvexClient } from "../db/convex";
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

  const convex = getConvexClient(env);
  const eventId = (await convex.mutation("usage_events:create", {
    organizationId: orgId,
    eventName: usage.type,
    metadata: buildLocalMetadata(usage, runId),
    polarIngested: false,
    createdAt: Date.now(),
  })) as string;

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
      await convex.mutation("usage_events:update", {
        id: eventId,
        polarIngested: true,
      });
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

  const convex = getConvexClient(env);
  try {
    const org = (await convex.query("organizations:getById", {
      id: orgId,
    })) as { _id: string } | null;

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
  const convex = getConvexClient(env);
  const events = (await convex.query("usage_events:listByOrgSince", {
    organizationId: orgId,
    since: 0,
    limit: 2000,
  })) as Array<{
    _id: string;
    eventName: string;
    metadata?: Record<string, unknown> | null;
    createdAt: number;
  }>;

  let totalCost = 0;
  let aiCost = 0;
  let sandboxCost = 0;

  for (const event of events) {
    const metadata = event.metadata ?? {};
    const cost = typeof metadata.costUSD === "number" ? metadata.costUSD : 0;
    totalCost += cost;
    if (event.eventName === "ai") {
      aiCost += cost;
    } else if (event.eventName === "sandbox") {
      sandboxCost += cost;
    }
  }

  const recentEvents = events.slice(0, RECENT_EVENTS_LIMIT);

  return {
    totalCostUSD: totalCost,
    breakdown: {
      ai: {
        costUSD: aiCost,
        percentage: totalCost > 0 ? (aiCost / totalCost) * 100 : 0,
      },
      sandbox: {
        costUSD: sandboxCost,
        percentage: totalCost > 0 ? (sandboxCost / totalCost) * 100 : 0,
      },
    },
    eventCount: events.length,
    recentEvents: recentEvents.map((e) => ({
      id: e._id,
      eventName: e.eventName,
      metadata: e.metadata ?? null,
      createdAt: new Date(e.createdAt),
    })),
  };
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
  const convex = getConvexClient(env);

  // Get failed events that haven't been ingested
  const failedEvents = (await convex.query("usage_events:listByPolarIngested", {
    polarIngested: false,
    limit,
  })) as Array<{
    _id: string;
    organizationId: string;
    eventName: string;
    metadata?: Record<string, unknown> | null;
  }>;

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
      id: event._id,
      eventName: event.eventName,
      metadata: event.metadata ?? {},
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
    await Promise.all(
      succeededIds.map((id) =>
        convex.mutation("usage_events:update", {
          id,
          polarIngested: true,
        })
      )
    );
  }

  return {
    processed: failedEvents.length,
    succeeded: succeededIds.length,
    failed: failedCount,
  };
};

export const getUsageSummary = async (
  env: Env,
  orgId: string
): Promise<UsageSummary> => {
  const convex = getConvexClient(env);
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - DEFAULT_PERIOD_DAYS);
  const periodEnd = new Date();

  const projects = (await convex.query("projects:listByOrg", {
    organizationId: orgId,
    includeRemoved: false,
    limit: 1000,
  })) as Array<{ _id: string; removedAt?: number }>;

  const activeProjects = projects.filter((project) => !project.removedAt);

  if (activeProjects.length === 0) {
    return {
      orgId,
      period: {
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
      runs: { total: 0, successful: 0, failed: 0 },
    };
  }

  let total = 0;
  let successful = 0;
  let failed = 0;

  const since = periodStart.getTime();
  for (const project of activeProjects) {
    const runs = (await convex.query("runs:listByProjectSince", {
      projectId: project._id,
      since,
      limit: 2000,
    })) as Array<{ conclusion?: string | null }>;

    total += runs.length;
    for (const run of runs) {
      if (run.conclusion === "success") {
        successful += 1;
      } else if (run.conclusion === "failure") {
        failed += 1;
      }
    }
  }

  return {
    orgId,
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    runs: {
      total,
      successful,
      failed,
    },
  };
};
