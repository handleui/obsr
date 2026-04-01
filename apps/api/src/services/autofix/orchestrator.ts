import type { KVNamespace } from "@cloudflare/workers-types";
import { createResolve, getResolvesByPr } from "../../db/operations/resolves";
import type { OrganizationSettings } from "../../lib/org-settings";
import type { Env } from "../../types/env";
import {
  acquireResolveCreationLock,
  releaseResolveCreationLock,
} from "../idempotency";
import { generateAutofixCommitMessage } from "./commit-message";
import { getAutofixesForSources, hasAutofix } from "./registry";

interface OrchestrationContext {
  env: Env;
  projectId: string;
  runId: string;
  commitSha: string;
  prNumber: number;
  branch: string;
  repoFullName: string; // e.g., "owner/repo"
  installationId: number;
  errors: Array<{
    id: string;
    source?: string;
    signatureId?: string;
    fixable?: boolean;
  }>;
  orgSettings: OrganizationSettings;
  userInstructions?: string;
}

interface PartialFailure {
  source: string;
  error: string;
  retryable: boolean;
}

interface OrchestrationResult {
  resolvesCreated: number;
  resolveIds: string[];
  partialFailures: PartialFailure[];
  // Configs for action to execute
  autofixes: Array<{
    resolveId: string;
    source: string;
    command: string;
  }>;
}

/**
 * Error patterns that indicate transient failures safe to retry.
 *
 * Anthropic API retryable errors (per SDK docs):
 * - 429: rate_limit_error
 * - 529: overloaded_error
 * - 500+: api_error, internal server errors
 * - Connection errors (timeout, reset, refused)
 *
 * NOT retryable (permanent failures):
 * - 400: invalid_request_error
 * - 401: authentication_error
 * - 403: permission_error
 * - 404: not_found_error
 * - 413: request_too_large
 * - billing_error
 *
 * NOTE: API retry patterns are defined here to keep retry logic self-contained.
 */
const API_RETRYABLE_PATTERNS = [
  // Rate limiting
  /rate.?limit/i,
  /too.?many.?requests/i,
  /429/,
  // Overload (Anthropic 529)
  /overloaded/i,
  /529/,
  // Server errors (500+)
  /internal.?(?:server.?)?error/i,
  /api.?error/i,
  /500/,
  /502/,
  /503/,
  /504/,
  /bad.?gateway/i,
  /service.?unavailable/i,
  /temporarily.?unavailable/i,
  // Timeouts (also in DB patterns but included for API completeness)
  /timeout/i,
  /timed.?out/i,
  /network.?error/i,
];

const classifyError = (
  error: unknown
): { message: string; retryable: boolean } => {
  const message = error instanceof Error ? error.message : String(error);
  // Check both API-specific and shared database transient patterns
  const retryable = API_RETRYABLE_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
  return { message, retryable };
};

/**
 * Create resolve records for fixable errors after a CI run.
 *
 * Algorithm:
 * 1. Filter to fixable errors only
 * 2. Group by source (biome, eslint, etc.)
 * 3. Check for existing pending resolves to avoid duplicates
 * 4. Create ONE resolve record per source (deduped - one resolve per source per PR)
 *
 * Robustness:
 * - Deduplication: Checks for existing pending/running resolves before creating
 * - KV locking: Prevents race conditions when multiple webhooks fire rapidly
 * - Error recovery: Continues processing other sources if one fails
 * - Graceful degradation: Returns empty result if DB connection fails
 */
export const orchestrateResolves = async (
  ctx: OrchestrationContext
): Promise<OrchestrationResult> => {
  const {
    env,
    projectId,
    runId,
    commitSha,
    prNumber,
    errors,
    orgSettings,
    userInstructions,
  } = ctx;

  // Check if autofix is enabled
  if (!orgSettings.autofixEnabled) {
    console.log(`[autofix] Autofix disabled for project ${projectId}`);
    return {
      resolvesCreated: 0,
      resolveIds: [],
      partialFailures: [],
      autofixes: [],
    };
  }

  // Filter to fixable errors
  const fixableErrors = errors.filter((e) => e.fixable && e.source);
  if (fixableErrors.length === 0) {
    console.log(`[autofix] No fixable errors for project ${projectId}`);
    return {
      resolvesCreated: 0,
      resolveIds: [],
      partialFailures: [],
      autofixes: [],
    };
  }

  // Group errors by source
  const errorsBySource = new Map<string, typeof fixableErrors>();
  for (const error of fixableErrors) {
    const source = error.source?.toLowerCase();
    if (!(source && hasAutofix(source))) {
      continue;
    }

    const existing = errorsBySource.get(source) || [];
    existing.push(error);
    errorsBySource.set(source, existing);
  }

  if (errorsBySource.size === 0) {
    console.log(
      `[autofix] No sources with autofix available for project ${projectId}`
    );
    return {
      resolvesCreated: 0,
      resolveIds: [],
      partialFailures: [],
      autofixes: [],
    };
  }

  let existingResolves: Awaited<ReturnType<typeof getResolvesByPr>> = [];
  try {
    existingResolves = await getResolvesByPr(env, projectId, prNumber);
  } catch (error) {
    console.error("[autofix] Failed to query resolves:", error);
    return {
      resolvesCreated: 0,
      resolveIds: [],
      partialFailures: [],
      autofixes: [],
    };
  }
  const kv = env["detent-idempotency"] as KVNamespace;

  const resolveIds: string[] = [];
  const partialFailures: PartialFailure[] = [];
  const autofixes: OrchestrationResult["autofixes"] = [];

  try {
    const existingSources = new Set(
      existingResolves
        .filter(
          (resolve) =>
            resolve.type === "autofix" &&
            (resolve.status === "pending" || resolve.status === "running")
        )
        .map((resolve) => resolve.autofixSource)
        .filter((source): source is string => source !== undefined)
    );

    // Get autofix configs sorted by priority
    const sources = Array.from(errorsBySource.keys());
    const configs = getAutofixesForSources(sources);

    // Create one resolve record per source (with deduplication and error recovery)
    for (const config of configs) {
      // Acquire KV lock to prevent duplicate resolve creation from concurrent webhooks
      const lockResult = await acquireResolveCreationLock(
        kv,
        projectId,
        prNumber,
        config.source
      );

      if (!lockResult.acquired) {
        console.log(
          `[autofix] Could not acquire lock for ${config.source} on PR #${prNumber}, skipping`
        );
        continue;
      }

      try {
        // Deduplication: Skip if we already have a pending/running resolve for this source
        if (existingSources.has(config.source)) {
          console.log(
            `[autofix] Resolve already exists for ${config.source} on PR #${prNumber}, skipping`
          );
          continue;
        }

        const sourceErrors = errorsBySource.get(config.source) || [];
        const errorIds = sourceErrors.map((e) => e.id);
        const signatureIds = sourceErrors
          .map((e) => e.signatureId)
          .filter((id): id is string => id !== undefined);

        // Generate commit message based on source and error count
        const commitMessage = generateAutofixCommitMessage(
          config.source,
          errorIds.length
        );

        const resolveId = await createResolve(env, {
          type: "autofix",
          projectId,
          runId,
          commitSha,
          prNumber,
          errorIds,
          signatureIds: [...new Set(signatureIds)],
          autofixSource: config.source,
          autofixCommand: config.command,
          commitMessage,
          userInstructions,
        });

        resolveIds.push(resolveId);
        autofixes.push({
          resolveId,
          source: config.source,
          command: config.command,
        });
        console.log(
          `[autofix] Created resolve ${resolveId} for ${config.source} (${errorIds.length} errors)`
        );

        // Release lock now since action will execute the autofix
        await releaseResolveCreationLock(
          kv,
          projectId,
          prNumber,
          config.source
        );
      } catch (error) {
        // Error recovery: Classify error, log, and continue with other sources
        const classified = classifyError(error);
        console.error(
          `[autofix] Failed to create resolve for ${config.source}:`,
          error
        );
        partialFailures.push({
          source: config.source,
          error: classified.message,
          retryable: classified.retryable,
        });

        // Release lock on error
        await releaseResolveCreationLock(
          kv,
          projectId,
          prNumber,
          config.source
        );
      }
    }

    // Log structured summary
    const totalSources = configs.length;
    const succeeded = resolveIds.length;
    const failed = partialFailures.length;

    if (failed > 0) {
      const failureSummary = partialFailures
        .map((f) => `${f.source}: ${f.retryable ? "TRANSIENT" : "PERMANENT"}`)
        .join(", ");
      console.log(
        `[autofix] Orchestration complete: ${succeeded}/${totalSources} succeeded, ${failed} failed (${failureSummary})`
      );
    } else if (succeeded > 0) {
      console.log(
        `[autofix] Orchestration complete: ${succeeded}/${totalSources} resolves created`
      );
    }

    return {
      resolvesCreated: resolveIds.length,
      resolveIds,
      partialFailures,
      autofixes,
    };
  } catch (error) {
    console.error("[autofix] Orchestration failed:", error);
    return {
      resolvesCreated: resolveIds.length,
      resolveIds,
      partialFailures,
      autofixes,
    };
  }
};
