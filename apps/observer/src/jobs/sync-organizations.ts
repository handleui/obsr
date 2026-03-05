/**
 * Cron job to sync all organizations with their GitHub state.
 * Reconciles repos (add new, soft-delete removed) and updates lastSyncedAt.
 *
 * Architecture notes:
 * - Uses Hyperdrive for connection pooling (managed by CF)
 * - Processes orgs in batches with delays to avoid GitHub secondary rate limits
 * - Limits total orgs per run to stay within CF Workers CPU limits (~30s)
 * - Individual org failures are isolated via Promise.allSettled
 */

import { getDbClient } from "../db/client";
import { sleep } from "../lib/async";
import { fetchAllPages } from "../lib/db-pagination";
import type { OrganizationSettings } from "../lib/org-settings";
import { createGitHubService } from "../services/github";
import {
  getLastKnownRateLimit,
  hasRateLimitHeadroom,
} from "../services/github/rate-limit";
import type { Env } from "../types/env";

// CF Workers scheduled handlers have ~30s CPU time limit
// 50 orgs × ~5 API calls × ~100ms = ~25s, safely under 30s limit
// Remaining orgs are deferred to next cron run (ordered by lastSyncedAt)
const MAX_ORGS_PER_RUN = 50;

// Batch size for concurrent processing
// GitHub recommends <10 concurrent requests to avoid secondary rate limits
const BATCH_SIZE = 5;

// Delay between batches to avoid secondary rate limits
// 100ms per batch × 10 batches = ~1s total delay overhead
const BATCH_DELAY_MS = 100;

export interface SyncJobResult {
  synced: number;
  failed: number;
  skipped: number;
  errors: string[];
  rateLimitRemaining?: number;
  durationMs: number;
}

type DbClient = ReturnType<typeof getDbClient>;

/**
 * Sync a single organization's repos with GitHub
 */
const syncOrganization = async (
  dbClient: DbClient,
  github: ReturnType<typeof createGitHubService>,
  org: {
    _id: string;
    slug: string;
    providerInstallationId: string;
    suspendedAt: number | null;
    providerAccountType: "organization" | "user";
    providerAccountLogin: string;
    settings: OrganizationSettings | null;
  }
): Promise<void> => {
  const installationId = Number(org.providerInstallationId);
  const now = Date.now();

  // Check if installation still exists
  const installationInfo = await github.getInstallationInfo(installationId);

  if (!installationInfo) {
    await dbClient.mutation("organizations:update", {
      id: org._id,
      deletedAt: now,
      lastSyncedAt: now,
      updatedAt: now,
    });

    console.log(
      `[sync-job] Installation removed for ${org.slug}, marked as deleted`
    );
    return;
  }

  // Update suspension status if changed
  const wasSuspended = Boolean(org.suspendedAt);
  const isSuspended = Boolean(installationInfo.suspended_at);

  if (wasSuspended !== isSuspended) {
    await dbClient.mutation("organizations:update", {
      id: org._id,
      suspendedAt: isSuspended
        ? new Date(installationInfo.suspended_at as string).getTime()
        : null,
      updatedAt: now,
    });
  }

  // Get current repos from GitHub and reconcile with our projects
  const githubRepos = await github.getInstallationRepos(installationId);
  await dbClient.mutation("projects:syncFromGitHub", {
    organizationId: org._id,
    repos: githubRepos.map((repo) => ({
      id: String(repo.id),
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
    })),
    syncRemoved: true,
  });

  // Member reconciliation - demote stale members to visitor
  if (org.providerAccountType === "organization" && org.providerAccountLogin) {
    const githubMembers = await github.getOrgMembers(
      installationId,
      org.providerAccountLogin
    );
    const githubUserIds = new Set(githubMembers.map((m) => String(m.id)));

    const detentMembers = await fetchAllPages<{
      _id: string;
      providerUserId?: string | null;
      membershipSource?: string | null;
      role?: string | null;
      removedAt?: number | null;
    }>(dbClient, "organization_members:paginateByOrg", {
      organizationId: org._id,
      includeRemoved: true,
    });

    const autoMembers = detentMembers.filter(
      (member) =>
        !member.removedAt &&
        member.providerUserId &&
        (member.membershipSource === "github_sync" ||
          member.membershipSource === "github_webhook" ||
          member.membershipSource === "github_access") &&
        (member.role === "member" || member.role === "admin")
    );

    const staleMembers = autoMembers.filter(
      (member) =>
        member.providerUserId && !githubUserIds.has(member.providerUserId)
    );

    if (staleMembers.length > 0) {
      for (const member of staleMembers) {
        await dbClient.mutation("organization_members:update", {
          id: member._id,
          role: "visitor",
          updatedAt: now,
        });
      }
      console.log(
        `[sync-job] Demoted ${staleMembers.length} members to visitor in ${org.slug}`
      );
    }

    const manualMembers = detentMembers.filter(
      (member) =>
        !member.removedAt &&
        member.providerUserId &&
        member.membershipSource === "manual_invite"
    );

    const verifiableMembers = manualMembers.filter(
      (member) =>
        member.providerUserId && githubUserIds.has(member.providerUserId)
    );

    if (verifiableMembers.length > 0) {
      for (const member of verifiableMembers) {
        await dbClient.mutation("organization_members:update", {
          id: member._id,
          membershipSource: "github_sync",
          updatedAt: now,
        });
      }
      console.log(
        `[sync-job] Verified ${verifiableMembers.length} manual members in ${org.slug}`
      );
    }
  }

  await dbClient.mutation("organizations:update", {
    id: org._id,
    lastSyncedAt: now,
    updatedAt: now,
  });
};

/**
 * Process organizations in batches to respect rate limits.
 * Adds delay between batches to avoid GitHub secondary rate limits.
 */
const processBatch = async <T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  processor: (item: T) => Promise<void>
): Promise<Array<{ item: T; error?: Error }>> => {
  const results: Array<{ item: T; error?: Error }> = [];

  for (let i = 0; i < items.length; i += batchSize) {
    // Add delay between batches (not before first batch)
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    console.log(
      `[sync-job] Processing batch ${batchNum}/${totalBatches} (${batch.length} orgs)`
    );

    const batchResults = await Promise.allSettled(batch.map(processor));

    for (const [index, outcome] of batchResults.entries()) {
      const item = batch[index];
      if (!item) {
        continue;
      }

      if (outcome.status === "fulfilled") {
        results.push({ item });
      } else {
        results.push({
          item,
          error:
            outcome.reason instanceof Error
              ? outcome.reason
              : new Error(String(outcome.reason)),
        });
      }
    }
  }

  return results;
};

/**
 * Sync all active organizations with their GitHub state.
 * - Limits orgs per run to stay within CF Workers CPU limits
 * - Processes in batches with delays to avoid secondary rate limits
 * - Checks rate limit headroom before processing
 */
export const syncAllOrganizations = async (
  env: Env
): Promise<SyncJobResult> => {
  const startTime = Date.now();
  const dbClient = getDbClient(env);

  // Query all active GitHub orgs with app installed, ordered by lastSyncedAt (oldest first)
  const allActiveOrgs = (await dbClient.query(
    "organizations:listActiveGithub",
    {
      limit: 5000,
    }
  )) as Array<{
    _id: string;
    slug: string;
    providerInstallationId: string;
    suspendedAt: number | null;
    providerAccountType: "organization" | "user";
    providerAccountLogin: string;
    settings: OrganizationSettings | null;
  }>;

  // Limit orgs per run to stay within CPU limits
  const skipped = Math.max(0, allActiveOrgs.length - MAX_ORGS_PER_RUN);
  const activeOrgs = allActiveOrgs.slice(0, MAX_ORGS_PER_RUN);

  console.log(
    `[sync-job] Starting sync for ${activeOrgs.length} organizations` +
      (skipped > 0 ? ` (${skipped} deferred to next run)` : "") +
      "..."
  );

  if (activeOrgs.length === 0) {
    return {
      synced: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      durationMs: Date.now() - startTime,
    };
  }

  const github = createGitHubService(env);

  // Process orgs in batches with delay between batches
  const results = await processBatch(
    activeOrgs,
    BATCH_SIZE,
    BATCH_DELAY_MS,
    async (org) => {
      // Check rate limit headroom before each org
      if (!hasRateLimitHeadroom()) {
        const rateLimit = getLastKnownRateLimit();
        throw new Error(
          `Rate limit low (${rateLimit?.remaining ?? "?"} remaining), skipping to preserve quota`
        );
      }
      await syncOrganization(dbClient, github, org);
      console.log(`[sync-job] Completed sync for ${org.slug}`);
    }
  );

  const synced = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;
  const errors = results
    .filter((r) => r.error)
    .map((r) => `${r.item.slug}: ${r.error?.message}`);

  // Get final rate limit state for observability
  const finalRateLimit = getLastKnownRateLimit();
  const durationMs = Date.now() - startTime;

  if (errors.length > 0) {
    console.error("[sync-job] Errors:", errors);
  }

  console.log(
    `[sync-job] Finished in ${durationMs}ms: ${synced} synced, ${failed} failed, ${skipped} deferred` +
      (finalRateLimit
        ? `, rate limit: ${finalRateLimit.remaining}/${finalRateLimit.limit}`
        : "")
  );

  return {
    synced,
    failed,
    skipped,
    errors,
    rateLimitRemaining: finalRateLimit?.remaining,
    durationMs,
  };
};
