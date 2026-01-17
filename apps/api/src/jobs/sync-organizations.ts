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

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import {
  type OrganizationSettings,
  organizationMembers,
  organizations,
  projects,
} from "../db/schema";
import { buildCaseExpression } from "../lib/sql-helpers";
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

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
}

interface ProjectSnapshot {
  id: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  isPrivate: boolean;
  removedAt: Date | null;
}

type DbClient = Awaited<ReturnType<typeof createDb>>["db"];

/**
 * Process repos that need to be added or reactivated.
 * Uses batch operations to minimize DB round-trips.
 */
const processReposToAdd = async (
  db: DbClient,
  reposToAdd: GitHubRepo[],
  projectsByRepoId: Map<string, ProjectSnapshot>,
  organizationId: string
): Promise<{ added: number; updated: number }> => {
  // Separate repos into those needing reactivation vs new inserts
  const toReactivate: Array<{ id: string; repo: GitHubRepo }> = [];
  const toInsert: GitHubRepo[] = [];

  for (const repo of reposToAdd) {
    const existing = projectsByRepoId.get(String(repo.id));
    if (existing?.removedAt) {
      toReactivate.push({ id: existing.id, repo });
    } else if (!existing) {
      toInsert.push(repo);
    }
  }

  // Batch reactivate: update all at once using CASE expressions
  if (toReactivate.length > 0) {
    const ids = toReactivate.map((r) => r.id);

    await db
      .update(projects)
      .set({
        removedAt: null,
        providerRepoName: buildCaseExpression(
          toReactivate.map(({ id, repo }) => ({ id, value: repo.name })),
          projects.id
        ),
        providerRepoFullName: buildCaseExpression(
          toReactivate.map(({ id, repo }) => ({ id, value: repo.full_name })),
          projects.id
        ),
        providerDefaultBranch: buildCaseExpression(
          toReactivate.map(({ id, repo }) => ({
            id,
            value: repo.default_branch,
          })),
          projects.id
        ),
        isPrivate: buildCaseExpression(
          toReactivate.map(({ id, repo }) => ({ id, value: repo.private })),
          projects.id
        ),
        updatedAt: new Date(),
      })
      .where(inArray(projects.id, ids));
  }

  // Batch insert: single INSERT with multiple values
  if (toInsert.length > 0) {
    await db.insert(projects).values(
      toInsert.map((repo) => ({
        id: crypto.randomUUID(),
        organizationId,
        handle: repo.name.toLowerCase(),
        providerRepoId: String(repo.id),
        providerRepoName: repo.name,
        providerRepoFullName: repo.full_name,
        providerDefaultBranch: repo.default_branch,
        isPrivate: repo.private,
      }))
    );
  }

  return { added: toInsert.length, updated: toReactivate.length };
};

/**
 * Update projects that exist in both GitHub and our DB but have changed.
 * Uses batch update with CASE expressions for efficiency.
 */
const updateChangedProjects = async (
  db: DbClient,
  githubRepos: GitHubRepo[],
  projectsByRepoId: Map<string, ProjectSnapshot>
): Promise<number> => {
  // Collect all projects that need updates
  const toUpdate: Array<{ id: string; repo: GitHubRepo }> = [];

  for (const repo of githubRepos) {
    const existing = projectsByRepoId.get(String(repo.id));
    const hasChanges =
      existing &&
      !existing.removedAt &&
      (existing.providerRepoName !== repo.name ||
        existing.providerRepoFullName !== repo.full_name ||
        existing.isPrivate !== repo.private);

    if (hasChanges && existing) {
      toUpdate.push({ id: existing.id, repo });
    }
  }

  if (toUpdate.length === 0) {
    return 0;
  }

  // Batch update using CASE expressions
  const ids = toUpdate.map((u) => u.id);

  await db
    .update(projects)
    .set({
      providerRepoName: buildCaseExpression(
        toUpdate.map(({ id, repo }) => ({ id, value: repo.name })),
        projects.id
      ),
      providerRepoFullName: buildCaseExpression(
        toUpdate.map(({ id, repo }) => ({ id, value: repo.full_name })),
        projects.id
      ),
      providerDefaultBranch: buildCaseExpression(
        toUpdate.map(({ id, repo }) => ({ id, value: repo.default_branch })),
        projects.id
      ),
      isPrivate: buildCaseExpression(
        toUpdate.map(({ id, repo }) => ({ id, value: repo.private })),
        projects.id
      ),
      updatedAt: new Date(),
    })
    .where(inArray(projects.id, ids));

  return toUpdate.length;
};

/**
 * Sync a single organization's repos with GitHub
 */
const syncOrganization = async (
  db: DbClient,
  github: ReturnType<typeof createGitHubService>,
  org: {
    id: string;
    slug: string;
    providerInstallationId: string;
    suspendedAt: Date | null;
    providerAccountType: "organization" | "user";
    providerAccountLogin: string;
    settings: OrganizationSettings | null;
  }
): Promise<void> => {
  const installationId = Number(org.providerInstallationId);

  // Check if installation still exists
  const installationInfo = await github.getInstallationInfo(installationId);

  if (!installationInfo) {
    // Installation was removed - mark organization as deleted
    await db
      .update(organizations)
      .set({
        deletedAt: new Date(),
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, org.id));

    console.log(
      `[sync-job] Installation removed for ${org.slug}, marked as deleted`
    );
    return;
  }

  // Update suspension status if changed
  const wasSuspended = Boolean(org.suspendedAt);
  const isSuspended = Boolean(installationInfo.suspended_at);

  if (wasSuspended !== isSuspended) {
    await db
      .update(organizations)
      .set({
        suspendedAt: isSuspended
          ? new Date(installationInfo.suspended_at as string)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, org.id));
  }

  // Get current repos from GitHub and reconcile with our projects
  const githubRepos = await github.getInstallationRepos(installationId);
  const githubRepoIds = new Set(githubRepos.map((r) => String(r.id)));

  // Get our current projects
  const ourProjects = await db
    .select({
      id: projects.id,
      providerRepoId: projects.providerRepoId,
      providerRepoName: projects.providerRepoName,
      providerRepoFullName: projects.providerRepoFullName,
      isPrivate: projects.isPrivate,
      removedAt: projects.removedAt,
    })
    .from(projects)
    .where(eq(projects.organizationId, org.id));

  const ourProjectsByRepoId = new Map(
    ourProjects.map((p) => [p.providerRepoId, p])
  );

  // Find repos to add (in GitHub but not in our DB or were soft-deleted)
  const reposToAdd = githubRepos.filter((repo) => {
    const existing = ourProjectsByRepoId.get(String(repo.id));
    return !existing || existing.removedAt;
  });

  // Process repos to add/reactivate
  if (reposToAdd.length > 0) {
    await processReposToAdd(db, reposToAdd, ourProjectsByRepoId, org.id);
  }

  // Find repos to remove (in our DB but no longer in GitHub)
  const projectsToRemove = ourProjects.filter(
    (p) => !(p.removedAt || githubRepoIds.has(p.providerRepoId))
  );

  if (projectsToRemove.length > 0) {
    const idsToRemove = projectsToRemove.map((p) => p.id);
    await db
      .update(projects)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(inArray(projects.id, idsToRemove));
  }

  // Update projects that exist in both (check for name/visibility changes)
  await updateChangedProjects(db, githubRepos, ourProjectsByRepoId);

  // Member reconciliation - demote stale members to visitor
  if (org.providerAccountType === "organization" && org.providerAccountLogin) {
    // Get current GitHub org members
    const githubMembers = await github.getOrgMembers(
      installationId,
      org.providerAccountLogin
    );
    const githubUserIds = new Set(githubMembers.map((m) => String(m.id)));

    // Only consider auto-joined members (not manual invites)
    // Security: Exclude owners (should not be auto-demoted) and visitors (no change needed)
    const autoMembers = await db
      .select({
        id: organizationMembers.id,
        providerUserId: organizationMembers.providerUserId,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, org.id),
          isNotNull(organizationMembers.providerUserId),
          isNull(organizationMembers.removedAt),
          // Only auto-joined sources (not manual_invite or installer)
          inArray(organizationMembers.membershipSource, [
            "github_sync",
            "github_webhook",
            "github_access",
          ]),
          // Security: Never demote owners automatically
          // Exclude visitors (no change needed)
          inArray(organizationMembers.role, ["member", "admin"])
        )
      );

    const staleMembers = autoMembers.filter(
      (m) => m.providerUserId && !githubUserIds.has(m.providerUserId)
    );

    if (staleMembers.length > 0) {
      await db
        .update(organizationMembers)
        .set({
          role: "visitor",
          updatedAt: new Date(),
        })
        .where(
          inArray(
            organizationMembers.id,
            staleMembers.map((m) => m.id)
          )
        );
      console.log(
        `[sync-job] Demoted ${staleMembers.length} members to visitor in ${org.slug}`
      );
    }

    // Verify manual_invite members who ARE in GitHub org
    // This upgrades them to github_sync so they're subject to future sync
    // Note: installers stay protected (they were trusted at install time)
    const manualMembers = await db
      .select({
        id: organizationMembers.id,
        providerUserId: organizationMembers.providerUserId,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, org.id),
          isNotNull(organizationMembers.providerUserId),
          isNull(organizationMembers.removedAt),
          eq(organizationMembers.membershipSource, "manual_invite")
        )
      );

    const verifiableMembers = manualMembers.filter(
      (m) => m.providerUserId && githubUserIds.has(m.providerUserId)
    );

    if (verifiableMembers.length > 0) {
      await db
        .update(organizationMembers)
        .set({
          membershipSource: "github_sync",
          updatedAt: new Date(),
        })
        .where(
          inArray(
            organizationMembers.id,
            verifiableMembers.map((m) => m.id)
          )
        );
      console.log(
        `[sync-job] Verified ${verifiableMembers.length} manual members in ${org.slug}`
      );
    }
  }

  // Update lastSyncedAt
  await db
    .update(organizations)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, org.id));
};

/**
 * Sleep helper for batch delays
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const { db, client } = await createDb(env);

  try {
    // Query all active GitHub orgs with app installed, ordered by lastSyncedAt (oldest first)
    const allActiveOrgs = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        providerInstallationId: organizations.providerInstallationId,
        suspendedAt: organizations.suspendedAt,
        providerAccountType: organizations.providerAccountType,
        providerAccountLogin: organizations.providerAccountLogin,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.provider, "github"),
          isNull(organizations.deletedAt),
          isNull(organizations.suspendedAt),
          isNotNull(organizations.providerInstallationId)
        )
      )
      .orderBy(organizations.lastSyncedAt);

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
      activeOrgs as Array<{
        id: string;
        slug: string;
        providerInstallationId: string;
        suspendedAt: Date | null;
        providerAccountType: "organization" | "user";
        providerAccountLogin: string;
        settings: OrganizationSettings | null;
      }>,
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
        await syncOrganization(db, github, org);
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
  } finally {
    await client.end();
  }
};
