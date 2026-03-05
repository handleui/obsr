import { runOps, type UsageMetadata, usageEventOps } from "@detent/db";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { getDbClient } from "../db/client";
import { getDb } from "../lib/db.js";
import type { Env } from "../types/env";
import {
  createPolarClient,
  getCustomerStateByExternalId,
  ingestUsageEvents,
} from "./polar";

const LOG_PREFIX = "[billing]";
const POLAR_EVENT_NAME = "usage";
const DEFAULT_PERIOD_DAYS = 30;
const RECENT_EVENTS_LIMIT = 10;
const MAX_POLAR_RETRIES = 3;
const POLAR_RETRY_DELAY_MS = 100;
const BATCH_SIZE = 50;

export type UsageType = "ai" | "sandbox";

interface AIUsageData {
  type: "ai";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

interface SandboxUsageData {
  type: "sandbox";
  durationMinutes: number;
  costUSD: number;
}

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

const buildLocalMetadata = (
  usage: UsageData,
  runId?: string
): UsageMetadata => {
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
  return {
    runId,
    durationMinutes: usage.durationMinutes,
    costUSD: usage.costUSD,
  };
};

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
  return {
    ...base,
    duration_minutes: usage.durationMinutes,
  };
};

export const recordUsage = async (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: UsageData,
  byok: boolean
): Promise<void> => {
  if (byok && usage.type === "ai") {
    return;
  }

  const { db, pool } = getDb(env);
  try {
    const event = await usageEventOps.create(db, {
      organizationId: orgId,
      eventName: usage.type,
      metadata: buildLocalMetadata(usage, runId),
      polarIngested: false,
      createdAt: Date.now(),
    });

    const polar = createPolarClient(env);
    try {
      await retryPolarIngestion(() =>
        ingestUsageEvents(polar, [
          {
            eventName: POLAR_EVENT_NAME,
            externalCustomerId: orgId,
            properties: buildPolarMetadata(usage),
            occurredAt: new Date(),
          },
        ])
      );
      await usageEventOps.update(db, event.id, {
        polarIngested: true,
      });
    } catch (error) {
      const errorType =
        error instanceof Error ? error.constructor.name : "UnknownError";
      console.error(
        JSON.stringify({
          level: "error",
          service: "billing",
          operation: "polar_ingestion",
          orgId,
          eventId: event.id,
          usageType: usage.type,
          errorType,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
      );

      Sentry.withScope((scope) => {
        scope.setTag("billing.operation", "polar_ingestion");
        scope.setTag("billing.org_id", orgId);
        scope.setTag("billing.usage_type", usage.type);
        scope.setTag("billing.recoverable", "true");
        scope.setLevel("warning");
        scope.setFingerprint(["billing", "polar_ingestion_failure"]);
        scope.setContext("usage_event", {
          eventId: event.id,
          usageType: usage.type,
          costUSD: usage.costUSD,
        });
        Sentry.captureException(error);
      });
    }
  } finally {
    await pool.end();
  }
};

export const recordAIUsage = (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: Omit<AIUsageData, "type">,
  byok: boolean
): Promise<void> =>
  recordUsage(env, orgId, runId, { ...usage, type: "ai" }, byok);

export const recordSandboxUsage = (
  env: Env,
  orgId: string,
  runId: string | undefined,
  usage: Omit<SandboxUsageData, "type">
): Promise<void> =>
  recordUsage(env, orgId, runId, { ...usage, type: "sandbox" }, false);

export const canRunResolve = async (
  env: Env,
  orgId: string
): Promise<BillingCheckResult> => {
  if (!env.POLAR_ACCESS_TOKEN) {
    return { allowed: true };
  }

  const dbClient = getDbClient(env);
  try {
    const org = (await dbClient.query("organizations:getById", {
      id: orgId,
    })) as { _id: string } | null;

    if (!org) {
      return { allowed: false, reason: "Organization not found" };
    }

    const polar = createPolarClient(env);
    const customerState = await getCustomerStateByExternalId(polar, orgId);

    if (!customerState) {
      return {
        allowed: false,
        reason: "No active subscription. Please subscribe to use resolving.",
      };
    }

    const hasActiveSubscription = customerState.activeSubscriptions.some(
      (sub) => sub.status === "active"
    );
    if (hasActiveSubscription) {
      return { allowed: true };
    }

    const hasCredits = customerState.activeMeters.some(
      (meter) => meter.balance > 0
    );
    if (hasCredits) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "No credits remaining. Please add more credits to continue.",
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to check billing status:`, error);

    // HACK: fail-open on Polar API failures to avoid blocking resolves during outages
    Sentry.withScope((scope) => {
      scope.setTag("billing.fail_open", "true");
      scope.setTag("billing.org_id", orgId);
      scope.setLevel("warning");
      scope.setFingerprint(["billing", "polar_api_failure"]);
      Sentry.captureException(error);
    });

    return { allowed: true };
  }
};

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
  const { db, pool } = getDb(env);
  try {
    const [costBreakdown, recentEvents] = await Promise.all([
      usageEventOps.aggregateCostByOrg(db, orgId),
      usageEventOps.listByOrg(db, orgId, RECENT_EVENTS_LIMIT),
    ]);

    const { totalCost, aiCost, sandboxCost, eventCount } = costBreakdown;

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
      eventCount,
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        eventName: e.eventName,
        metadata: (e.metadata as Record<string, unknown>) ?? null,
        createdAt: new Date(e.createdAt),
      })),
    };
  } finally {
    await pool.end();
  }
};

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
  return {
    ...base,
    duration_minutes: (metadata.durationMinutes as number) ?? 0,
  };
};

export const retryFailedPolarIngestions = async (
  env: Env,
  limit = BATCH_SIZE
): Promise<{ processed: number; succeeded: number; failed: number }> => {
  const { db, pool } = getDb(env);

  try {
    const failedEvents = await usageEventOps.listByPolarIngested(
      db,
      false,
      limit
    );

    if (failedEvents.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const polar = createPolarClient(env);
    const succeededIds: string[] = [];
    let failedCount = 0;

    const eventsByOrg = new Map<
      string,
      Array<{
        id: string;
        eventName: string;
        metadata: Record<string, unknown>;
        createdAt: number;
      }>
    >();
    for (const event of failedEvents) {
      const orgEvents = eventsByOrg.get(event.organizationId) ?? [];
      orgEvents.push({
        id: event.id,
        eventName: event.eventName,
        metadata: (event.metadata as Record<string, unknown>) ?? {},
        createdAt: event.createdAt,
      });
      eventsByOrg.set(event.organizationId, orgEvents);
    }

    for (const [orgId, events] of eventsByOrg) {
      try {
        await retryPolarIngestion(() =>
          ingestUsageEvents(
            polar,
            events.map((e) => ({
              eventName: POLAR_EVENT_NAME,
              externalCustomerId: orgId,
              properties: buildRetryPolarMetadata(e.eventName, e.metadata),
              occurredAt: new Date(e.createdAt),
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

    if (succeededIds.length > 0) {
      await usageEventOps.markPolarIngestedBatch(db, succeededIds);
    }

    return {
      processed: failedEvents.length,
      succeeded: succeededIds.length,
      failed: failedCount,
    };
  } finally {
    await pool.end();
  }
};

const countRunsByConclusion = (
  allProjectRuns: Array<Array<{ conclusion?: string | null }>>
): { total: number; successful: number; failed: number } => {
  let total = 0;
  let successful = 0;
  let failed = 0;

  for (const projectRuns of allProjectRuns) {
    total += projectRuns.length;
    for (const run of projectRuns) {
      if (run.conclusion === "success") {
        successful += 1;
      } else if (run.conclusion === "failure") {
        failed += 1;
      }
    }
  }

  return { total, successful, failed };
};

export const getUsageSummary = async (
  env: Env,
  orgId: string
): Promise<UsageSummary> => {
  const dbClient = getDbClient(env);
  const { db, pool } = getDb(env);
  try {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - DEFAULT_PERIOD_DAYS);
    const periodEnd = new Date();

    const projects = (await dbClient.query("projects:listByOrg", {
      organizationId: orgId,
      includeRemoved: false,
      limit: 1000,
    })) as Array<{ _id: string; removedAt?: number }>;

    const activeProjects = projects.filter((project) => !project.removedAt);
    const period = {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    };

    if (activeProjects.length === 0) {
      return { orgId, period, runs: { total: 0, successful: 0, failed: 0 } };
    }

    const since = periodStart.getTime();
    const allProjectRuns = await Promise.all(
      activeProjects.map((project) =>
        runOps.listByProjectSince(db, project._id, since, 2000)
      )
    );

    return {
      orgId,
      period,
      runs: countRunsByConclusion(allProjectRuns),
    };
  } finally {
    await pool.end();
  }
};
