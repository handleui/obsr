import type { KVNamespace } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { createHeal, updateHealStatus } from "../../db/operations/heals";
import { heals, type OrganizationSettings } from "../../db/schema";
import type { Env } from "../../types/env";
import { createGitHubService } from "../github";
import {
  acquireHealCreationLock,
  releaseHealCreationLock,
} from "../idempotency";
import { buildGitHubRepoUrl, triggerModalAutofix } from "../modal/trigger";
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
}

interface OrchestrationResult {
  healsCreated: number;
  healIds: string[];
}

// Type for database operations
type DbOrTx = Parameters<typeof createHeal>[0];

/**
 * Trigger Modal executor for an autofix job.
 *
 * This function:
 * 1. Gets a GitHub installation token
 * 2. Triggers the Modal executor
 * 3. Updates heal status to 'running' or 'failed'
 */
const triggerModalExecutor = async (
  env: Env,
  db: DbOrTx,
  healId: string,
  command: string,
  repoFullName: string,
  branch: string,
  commitSha: string,
  installationId: number
): Promise<void> => {
  const github = createGitHubService(env);

  try {
    // Get installation token for repo access
    const token = await github.getInstallationToken(installationId);

    // Trigger Modal executor
    const result = await triggerModalAutofix(env, {
      healId,
      repoUrl: buildGitHubRepoUrl(repoFullName),
      commitSha,
      branch,
      command,
      githubToken: token,
    });

    if (result.success) {
      // Modal accepted the job - mark as running
      await updateHealStatus(db, healId, "running");
      console.log(`[autofix] Heal ${healId} is now running on Modal`);
    } else {
      // Modal rejected the job - mark as failed
      await updateHealStatus(db, healId, "failed", {
        failedReason: result.error || "Modal executor rejected job",
      });
      console.error(
        `[autofix] Heal ${healId} failed to start: ${result.error}`
      );
    }
  } catch (error) {
    // Failed to trigger - mark as failed
    const message = error instanceof Error ? error.message : String(error);
    await updateHealStatus(db, healId, "failed", {
      failedReason: `Trigger failed: ${message}`,
    });
    console.error(`[autofix] Heal ${healId} trigger error: ${message}`);
  }
};

/**
 * Create heal records for fixable errors after a CI run.
 *
 * Algorithm:
 * 1. Filter to fixable errors only
 * 2. Group by source (biome, eslint, etc.)
 * 3. Check for existing pending heals to avoid duplicates
 * 4. Create ONE heal record per source (deduped - one heal per source per PR)
 *
 * Robustness:
 * - Deduplication: Checks for existing pending/running heals before creating
 * - KV locking: Prevents race conditions when multiple webhooks fire rapidly
 * - Error recovery: Continues processing other sources if one fails
 * - Graceful degradation: Returns empty result if DB connection fails
 */
export const orchestrateHeals = async (
  ctx: OrchestrationContext
): Promise<OrchestrationResult> => {
  const { env, projectId, runId, commitSha, prNumber, errors, orgSettings } =
    ctx;

  // Check if autofix is enabled
  if (!orgSettings.autofixEnabled) {
    console.log(`[autofix] Autofix disabled for project ${projectId}`);
    return { healsCreated: 0, healIds: [] };
  }

  // Filter to fixable errors
  const fixableErrors = errors.filter((e) => e.fixable && e.source);
  if (fixableErrors.length === 0) {
    console.log(`[autofix] No fixable errors for project ${projectId}`);
    return { healsCreated: 0, healIds: [] };
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
    return { healsCreated: 0, healIds: [] };
  }

  // Graceful degradation: if DB connection fails, return empty result
  const dbResult = await createDb(env).catch((error) => {
    console.error("[autofix] Failed to connect to database:", error);
    return null;
  });

  if (!dbResult) {
    return { healsCreated: 0, healIds: [] };
  }

  const { db, client } = dbResult;
  const kv = env["detent-idempotency"] as KVNamespace;

  const healIds: string[] = [];
  const failedSources: string[] = [];

  try {
    // Check for existing pending/running heals for this PR to avoid duplicates
    const existingHeals = await db
      .select({
        id: heals.id,
        autofixSource: heals.autofixSource,
        status: heals.status,
      })
      .from(heals)
      .where(
        and(
          eq(heals.projectId, projectId),
          eq(heals.prNumber, prNumber),
          eq(heals.type, "autofix")
        )
      );

    // Build a set of sources that already have pending/running heals
    const existingSources = new Set(
      existingHeals
        .filter((h) => h.status === "pending" || h.status === "running")
        .map((h) => h.autofixSource)
        .filter((s): s is string => s !== null)
    );

    // Get autofix configs sorted by priority
    const sources = Array.from(errorsBySource.keys());
    const configs = getAutofixesForSources(sources);

    // Create one heal record per source (with deduplication and error recovery)
    for (const config of configs) {
      // Acquire KV lock to prevent duplicate heal creation from concurrent webhooks
      const lockResult = await acquireHealCreationLock(
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
        // Deduplication: Skip if we already have a pending/running heal for this source
        if (existingSources.has(config.source)) {
          console.log(
            `[autofix] Heal already exists for ${config.source} on PR #${prNumber}, skipping`
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

        const healId = await createHeal(db, {
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
        });

        healIds.push(healId);
        console.log(
          `[autofix] Created heal ${healId} for ${config.source} (${errorIds.length} errors)`
        );

        // Trigger Modal executor and release lock when done
        // Wrap in Promise.resolve() to ensure .finally() runs even if the function
        // throws synchronously before returning a promise
        Promise.resolve(
          triggerModalExecutor(
            env,
            db,
            healId,
            config.command,
            ctx.repoFullName,
            ctx.branch,
            commitSha,
            ctx.installationId
          )
        )
          .catch((err) => {
            console.error(`[autofix] Modal trigger failed for ${healId}:`, err);
          })
          .finally(() => {
            // Release lock after Modal trigger completes (or fails)
            releaseHealCreationLock(kv, projectId, prNumber, config.source);
          });
      } catch (error) {
        // Error recovery: Log and continue with other sources
        console.error(
          `[autofix] Failed to create heal for ${config.source}:`,
          error
        );
        failedSources.push(config.source);

        // Release lock on error
        await releaseHealCreationLock(kv, projectId, prNumber, config.source);
      }
    }

    if (failedSources.length > 0) {
      console.log(
        `[autofix] Failed to create heals for sources: ${failedSources.join(", ")}`
      );
    }

    return { healsCreated: healIds.length, healIds };
  } finally {
    await client.end();
  }
};
