/**
 * Organizations API routes
 *
 * Handles organization-specific operations like status and details.
 */

import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  getOrgSettings,
  type OrganizationSettings,
  organizationMembers,
  organizations,
  projects,
} from "../db/schema";
import { cacheKey, deleteFromCache } from "../lib/cache";
import { buildCaseExpression } from "../lib/sql-helpers";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { createGitHubService } from "../services/github";
import type { Env } from "../types/env";

interface SyncResult {
  added: number;
  removed: number;
  updated: number;
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

interface GitHubMember {
  id: number;
  login: string;
}

interface MemberSyncResult {
  active: number;
  potential: number;
  stale: number;
  added: number;
  removed: number;
  total_github: number;
}

interface RemovedMemberLookups {
  blockedUserIds: Set<string>;
  mirrorRemovedById: Map<string, string>;
}

/**
 * Build lookup maps for blocked and mirror-removed members
 */
const buildRemovedMemberLookups = (
  removedMembers: Array<{
    id: string;
    providerUserId: string | null;
    removalReason: string | null;
  }>
): RemovedMemberLookups => {
  const blockedUserIds = new Set<string>();
  const mirrorRemovedById = new Map<string, string>();

  for (const m of removedMembers) {
    if (!m.providerUserId) {
      continue;
    }
    if (m.removalReason === "admin_action") {
      blockedUserIds.add(m.providerUserId);
    } else if (m.removalReason === "github_left") {
      mirrorRemovedById.set(m.providerUserId, m.id);
    }
  }

  return { blockedUserIds, mirrorRemovedById };
};

/**
 * Categorize potential members into those to reactivate vs insert
 */
const categorizePotentialMembers = (
  potentialMembers: GitHubMember[],
  lookups: RemovedMemberLookups,
  existingUsersByGhId: Map<string, string>
): {
  toReactivate: Array<{ id: string; login: string }>;
  toInsert: Array<{ userId: string; ghUserId: string; login: string }>;
} => {
  const toReactivate: Array<{ id: string; login: string }> = [];
  const toInsert: Array<{
    userId: string;
    ghUserId: string;
    login: string;
  }> = [];

  for (const ghMember of potentialMembers) {
    const ghUserId = String(ghMember.id);

    if (lookups.blockedUserIds.has(ghUserId)) {
      continue;
    }

    const mirrorRemovedId = lookups.mirrorRemovedById.get(ghUserId);
    if (mirrorRemovedId) {
      toReactivate.push({ id: mirrorRemovedId, login: ghMember.login });
      continue;
    }

    const existingUserId = existingUsersByGhId.get(ghUserId);
    if (existingUserId) {
      toInsert.push({
        userId: existingUserId,
        ghUserId,
        login: ghMember.login,
      });
    }
  }

  return { toReactivate, toInsert };
};

/**
 * Batch reactivate mirror-removed members
 */
const batchReactivateMembers = async (
  db: DbClient,
  toReactivate: Array<{ id: string; login: string }>
): Promise<void> => {
  if (toReactivate.length === 0) {
    return;
  }

  const reactivateIds = toReactivate.map((r) => r.id);
  const usernameChunks: ReturnType<typeof sql>[] = [sql`(case`];
  for (const { id, login } of toReactivate) {
    usernameChunks.push(
      sql` when ${organizationMembers.id} = ${id} then ${login}`
    );
  }
  usernameChunks.push(sql` end)`);

  await db
    .update(organizationMembers)
    .set({
      removedAt: null,
      removalReason: null,
      removedBy: null,
      providerUsername: sql.join(usernameChunks, sql.raw("")),
      providerVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(organizationMembers.id, reactivateIds));
};

/**
 * Batch insert new members
 */
const batchInsertMembers = async (
  db: DbClient,
  organizationId: string,
  toInsert: Array<{ userId: string; ghUserId: string; login: string }>
): Promise<void> => {
  if (toInsert.length === 0) {
    return;
  }

  await db.insert(organizationMembers).values(
    toInsert.map(({ userId, ghUserId, login }) => ({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "member" as const,
      providerUserId: ghUserId,
      providerUsername: login,
      providerLinkedAt: new Date(),
      providerVerifiedAt: new Date(),
      membershipSource: "github_sync",
    }))
  );
};

/**
 * Sync organization members with GitHub.
 * Actively reconciles memberships based on GitHub org membership.
 */
const syncOrganizationMembers = async (
  db: DbClient,
  organizationId: string,
  githubMembers: GitHubMember[]
): Promise<MemberSyncResult> => {
  // Get existing active Detent members for this org
  const detentMembers = await db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      providerUserId: organizationMembers.providerUserId,
      providerUsername: organizationMembers.providerUsername,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizationMembers.removedAt)
      )
    );

  const githubMemberIds = new Set(githubMembers.map((m) => String(m.id)));
  const detentMemberIds = new Set(
    detentMembers
      .map((m) => m.providerUserId)
      .filter((id): id is string => id !== null)
  );

  // Active: in both Detent and GitHub
  const activeMembers = detentMembers.filter(
    (m) => m.providerUserId && githubMemberIds.has(m.providerUserId)
  );

  // Potential: in GitHub but not in Detent
  const potentialMembers = githubMembers.filter(
    (m) => !detentMemberIds.has(String(m.id))
  );

  // Stale: in Detent but no longer in GitHub (excluding owners)
  const staleMembers = detentMembers.filter(
    (m) =>
      m.providerUserId &&
      !githubMemberIds.has(m.providerUserId) &&
      m.role !== "owner"
  );

  let added = 0;
  let removed = 0;

  // Active reconciliation for potential members
  if (potentialMembers.length > 0) {
    const potentialGhIds = potentialMembers.map((m) => String(m.id));

    // Batch query: get all removed members for these GitHub IDs in this org
    const removedMembers = await db
      .select({
        id: organizationMembers.id,
        providerUserId: organizationMembers.providerUserId,
        removalReason: organizationMembers.removalReason,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          inArray(organizationMembers.providerUserId, potentialGhIds),
          isNotNull(organizationMembers.removedAt)
        )
      );

    const lookups = buildRemovedMemberLookups(removedMembers);

    // Batch query: find existing Detent users by providerUserId (in any org)
    const nonBlockedGhIds = potentialGhIds.filter(
      (id) =>
        !(lookups.blockedUserIds.has(id) || lookups.mirrorRemovedById.has(id))
    );

    // Note: This query intentionally doesn't filter by organizationId to find users
    // who exist in Detent via any org. If a GitHub user has memberships in multiple
    // Detent orgs with different internal userIds (edge case from manual data entry),
    // the Map will keep the last one. This is acceptable because:
    // 1. Normal flow: same GitHub user = same Detent user across all orgs
    // 2. We just need any valid userId to link the membership
    const existingUsersByGhId = new Map<string, string>();
    if (nonBlockedGhIds.length > 0) {
      const existingUsers = await db
        .select({
          providerUserId: organizationMembers.providerUserId,
          userId: organizationMembers.userId,
        })
        .from(organizationMembers)
        .where(inArray(organizationMembers.providerUserId, nonBlockedGhIds));

      for (const u of existingUsers) {
        if (u.providerUserId) {
          existingUsersByGhId.set(u.providerUserId, u.userId);
        }
      }
    }

    const { toReactivate, toInsert } = categorizePotentialMembers(
      potentialMembers,
      lookups,
      existingUsersByGhId
    );

    await batchReactivateMembers(db, toReactivate);
    added += toReactivate.length;

    await batchInsertMembers(db, organizationId, toInsert);
    added += toInsert.length;
  }

  // Soft-delete stale members (not in GitHub, not owners)
  if (staleMembers.length > 0) {
    const staleIds = staleMembers.map((m) => m.id);
    await db
      .update(organizationMembers)
      .set({
        removedAt: new Date(),
        removalReason: "github_left",
        removedBy: "system",
        updatedAt: new Date(),
      })
      .where(inArray(organizationMembers.id, staleIds));
    removed = staleMembers.length;
  }

  // Update providerVerifiedAt for active members
  if (activeMembers.length > 0) {
    const activeIds = activeMembers.map((m) => m.id);
    await db
      .update(organizationMembers)
      .set({ providerVerifiedAt: new Date(), updatedAt: new Date() })
      .where(inArray(organizationMembers.id, activeIds));
  }

  return {
    active: activeMembers.length,
    potential: potentialMembers.length,
    stale: staleMembers.length,
    added,
    removed,
    total_github: githubMembers.length,
  };
};

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /:organizationId/status
 * Get detailed status of an organization including GitHub App installation
 */
app.get("/:organizationId/status", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization } = orgAccess;

  const { db, client } = await createDb(c.env);
  try {
    // Fetch full organization details (middleware only provides subset)
    const fullOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, organization.id),
    });

    if (!fullOrg) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Count active projects efficiently using SQL COUNT
    const projectCountResult = await db
      .select({ count: count() })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organization.id),
          isNull(projects.removedAt)
        )
      );

    const appInstalled = Boolean(organization.providerInstallationId);
    const projectCount = projectCountResult[0]?.count ?? 0;
    const settings = getOrgSettings(fullOrg.settings);

    return c.json({
      organization_id: fullOrg.id,
      organization_name: fullOrg.name,
      organization_slug: fullOrg.slug,
      provider: fullOrg.provider,
      provider_account_login: fullOrg.providerAccountLogin,
      provider_account_type: fullOrg.providerAccountType,
      app_installed: appInstalled,
      suspended_at: fullOrg.suspendedAt?.toISOString() ?? null,
      project_count: projectCount,
      created_at: fullOrg.createdAt.toISOString(),
      last_synced_at: fullOrg.lastSyncedAt?.toISOString() ?? null,
      settings: {
        enable_inline_annotations: settings.enableInlineAnnotations,
        enable_pr_comments: settings.enablePrComments,
      },
    });
  } finally {
    await client.end();
  }
});

/**
 * POST /:organizationId/sync
 * Sync organization state with GitHub (check installation, update repos)
 * This reconciles our database with the current GitHub state
 */
app.post(
  "/:organizationId/sync",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const organizationId = organization.id;

    // Middleware already verifies: GitHub provider, app installed, not suspended
    const github = createGitHubService(c.env);
    const installationId = Number(organization.providerInstallationId);

    const { db, client } = await createDb(c.env);
    try {
      // Fetch full org to get suspendedAt (middleware subset doesn't include it)
      const fullOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      });

      if (!fullOrg) {
        return c.json({ error: "Organization not found" }, 404);
      }

      // 1. Check if installation still exists and get its status
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
          .where(eq(organizations.id, organizationId));

        return c.json({
          message: "installation_removed",
          organization_id: organizationId,
          synced: true,
        });
      }

      // 2. Update suspension status if changed
      const wasSuspended = Boolean(fullOrg.suspendedAt);
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
          .where(eq(organizations.id, organizationId));
      }

      // 3. Get current repos from GitHub and reconcile with our projects
      const githubRepos = await github.getInstallationRepos(installationId);
      const githubRepoIds = new Set(githubRepos.map((r) => String(r.id)));

      // Get our current active projects
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
        .where(eq(projects.organizationId, organizationId));

      const ourProjectsByRepoId = new Map(
        ourProjects.map((p) => [p.providerRepoId, p])
      );

      const result: SyncResult = { added: 0, removed: 0, updated: 0 };

      // Find repos to add (in GitHub but not in our DB or were soft-deleted)
      const reposToAdd = githubRepos.filter((repo) => {
        const existing = ourProjectsByRepoId.get(String(repo.id));
        return !existing || existing.removedAt;
      });

      // Process repos to add/reactivate
      if (reposToAdd.length > 0) {
        const addResult = await processReposToAdd(
          db,
          reposToAdd,
          ourProjectsByRepoId,
          organizationId
        );
        result.added = addResult.added;
        result.updated += addResult.updated;
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
        result.removed = projectsToRemove.length;
      }

      // Update projects that exist in both (check for name/visibility changes)
      const changedCount = await updateChangedProjects(
        db,
        githubRepos,
        ourProjectsByRepoId
      );
      result.updated += changedCount;

      // 4. Sync organization members (if app has members:read permission)
      let memberSyncResult: MemberSyncResult | null = null;

      // Only sync members for organizations (not personal accounts)
      if (organization.providerAccountType === "organization") {
        try {
          const githubMembers = await github.getOrgMembers(
            installationId,
            organization.providerAccountLogin
          );

          memberSyncResult = await syncOrganizationMembers(
            db,
            organizationId,
            githubMembers
          );
        } catch (error) {
          // Log but don't fail sync if member fetch fails (e.g., permission denied)
          console.warn(
            `[organizations/sync] Member sync failed for ${organization.slug}:`,
            error instanceof Error ? error.message : error
          );
        }
      }

      // 5. Update lastSyncedAt
      await db
        .update(organizations)
        .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));

      return c.json({
        message: "sync completed",
        organization_id: organizationId,
        suspended: isSuspended,
        projects: {
          added: result.added,
          removed: result.removed,
          updated: result.updated,
          total: githubRepos.length,
        },
        // Include flat fields for backward compat
        projects_added: result.added,
        projects_removed: result.removed,
        projects_updated: result.updated,
        total_repos: githubRepos.length,
        // New member sync results (null if personal account or permission denied)
        ...(memberSyncResult && { members: memberSyncResult }),
        synced_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[organizations/sync] Error:", error);
      return c.json(
        {
          message: "sync error",
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    } finally {
      await client.end();
    }
  }
);

/**
 * PATCH /:organizationId/settings
 * Update organization settings
 *
 * SECURITY: Setting-specific authorization:
 * - allow_auto_join: owner only (controls who can access the org)
 * - enable_inline_annotations, enable_pr_comments: owner or admin
 */
app.patch(
  "/:organizationId/settings",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    // Parse body as unknown to enforce runtime validation
    const body: unknown = await c.req.json();

    // Validate body is a plain object
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          error: "Invalid request body",
          message: "Request body must be a JSON object",
        },
        400
      );
    }

    const validKeys = [
      "enable_inline_annotations",
      "enable_pr_comments",
    ] as const;
    type ValidKey = (typeof validKeys)[number];
    const validKeySet = new Set<string>(validKeys);

    // Reject unknown keys to prevent injection attempts
    const bodyKeys = Object.keys(body);
    const unknownKeys = bodyKeys.filter((key) => !validKeySet.has(key));
    if (unknownKeys.length > 0) {
      return c.json(
        {
          error: "Invalid request body",
          message: `Unknown settings: ${unknownKeys.join(", ")}. Valid settings are: ${validKeys.join(", ")}`,
        },
        400
      );
    }

    // Validate: all provided values must be booleans
    const providedSettings: Partial<Record<ValidKey, boolean>> = {};
    const bodyRecord = body as Record<string, unknown>;

    for (const key of validKeys) {
      if (key in bodyRecord) {
        const value = bodyRecord[key];
        if (typeof value !== "boolean") {
          return c.json(
            {
              error: "Invalid request body",
              message: `${key} must be a boolean`,
            },
            400
          );
        }
        providedSettings[key] = value;
      }
    }

    if (Object.keys(providedSettings).length === 0) {
      return c.json(
        {
          error: "Invalid request body",
          message: "At least one valid setting must be provided",
        },
        400
      );
    }

    const { db, client } = await createDb(c.env);
    try {
      // Fetch current settings
      const current = await db.query.organizations.findFirst({
        where: eq(organizations.id, organization.id),
        columns: { settings: true },
      });

      // Merge with new settings (snake_case to camelCase)
      const newSettings: OrganizationSettings = {
        ...current?.settings,
        ...(providedSettings.enable_inline_annotations !== undefined && {
          enableInlineAnnotations: providedSettings.enable_inline_annotations,
        }),
        ...(providedSettings.enable_pr_comments !== undefined && {
          enablePrComments: providedSettings.enable_pr_comments,
        }),
      };

      await db
        .update(organizations)
        .set({
          settings: newSettings,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organization.id));

      // Invalidate org settings cache so webhooks pick up changes immediately
      if (organization.providerInstallationId) {
        deleteFromCache(
          cacheKey.orgSettings(organization.providerInstallationId)
        );
      }

      const finalSettings = getOrgSettings(newSettings);

      return c.json({
        success: true,
        settings: {
          enable_inline_annotations: finalSettings.enableInlineAnnotations,
          enable_pr_comments: finalSettings.enablePrComments,
        },
      });
    } finally {
      await client.end();
    }
  }
);

/**
 * DELETE /:organizationId
 * Delete an organization (soft-delete)
 * Only owners can delete organizations
 */
app.delete(
  "/:organizationId",
  githubOrgAccessMiddleware,
  requireRole("owner"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const { db, client } = await createDb(c.env);
    try {
      // Re-check org exists and isn't already deleted (prevents race condition)
      const fresh = await db.query.organizations.findFirst({
        where: and(
          eq(organizations.id, organization.id),
          isNull(organizations.deletedAt)
        ),
      });

      if (!fresh) {
        return c.json(
          { error: "Organization not found or already deleted" },
          404
        );
      }

      // Soft-delete the organization
      // HACK: organization_members intentionally left intact for potential recovery.
      // Hard-delete should cascade to members via DB constraint or explicit cleanup.
      await db
        .update(organizations)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organization.id));

      // Invalidate cache if applicable
      if (organization.providerInstallationId) {
        deleteFromCache(
          cacheKey.orgSettings(organization.providerInstallationId)
        );
      }

      return c.json({
        success: true,
        provider_account_login: organization.providerAccountLogin,
        provider_account_type: organization.providerAccountType,
      });
    } finally {
      await client.end();
    }
  }
);

// WorkOS user IDs follow the pattern: user_<alphanumeric>
// Use flexible length to avoid breaking if WorkOS changes their ID format
const WORKOS_USER_ID_PATTERN = /^user_[a-zA-Z0-9]+$/;

const isValidWorkOSUserId = (userId: string): boolean =>
  WORKOS_USER_ID_PATTERN.test(userId);

/**
 * DELETE /:organizationId/members/:userId
 * Remove a member from an organization
 * Only owners and admins can remove members (but not owners)
 *
 * SECURITY:
 * - Validates userId format to prevent invalid lookups
 * - Prevents self-removal
 * - Prevents owner removal (must transfer ownership first)
 * - Admins cannot remove other admins (only owners can)
 */
app.delete(
  "/:organizationId/members/:userId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization, role: callerRole } = orgAccess;
    const auth = c.get("auth");
    const callerId = auth.userId;
    const targetUserId = c.req.param("userId");

    // SECURITY: Validate userId format to prevent invalid database lookups
    if (!isValidWorkOSUserId(targetUserId)) {
      return c.json({ error: "Invalid user ID format" }, 400);
    }

    // Cannot remove yourself
    if (targetUserId === callerId) {
      return c.json(
        { error: "Forbidden", message: "Cannot remove yourself" },
        403
      );
    }

    const { db, client } = await createDb(c.env);
    try {
      // Use transaction to prevent TOCTOU race conditions
      // All checks and the update happen atomically
      const result = await db.transaction(async (tx) => {
        // Find the target member (active members only)
        const targetMember = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.organizationId, organization.id),
            eq(organizationMembers.userId, targetUserId),
            isNull(organizationMembers.removedAt)
          ),
        });

        if (!targetMember) {
          return { error: "Member not found", status: 404 as const };
        }

        // Cannot remove an owner
        if (targetMember.role === "owner") {
          return {
            error: "Forbidden",
            message:
              "Cannot remove owner. Transfer ownership first or delete the organization.",
            status: 403 as const,
          };
        }

        // SECURITY: Admins cannot remove other admins (only owners can)
        // This prevents privilege escalation where an admin removes all other admins
        if (callerRole === "admin" && targetMember.role === "admin") {
          return {
            error: "Forbidden",
            message: "Admins cannot remove other admins. Contact an owner.",
            status: 403 as const,
          };
        }

        // Soft delete the member
        await tx
          .update(organizationMembers)
          .set({
            removedAt: new Date(),
            removalReason: "admin_action",
            removedBy: callerId,
            updatedAt: new Date(),
          })
          .where(eq(organizationMembers.id, targetMember.id));

        return { success: true, removed_user_id: targetUserId };
      });

      // Handle transaction result
      if ("error" in result) {
        const { status, ...errorBody } = result;
        return c.json(errorBody, status);
      }

      return c.json({
        success: true,
        removed_user_id: targetUserId,
      });
    } finally {
      await client.end();
    }
  }
);

/**
 * GET /:organizationId/members
 * List all members of an organization
 * Only owners and admins can view members
 */
app.get(
  "/:organizationId/members",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const { db, client } = await createDb(c.env);
    try {
      const members = await db
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          providerUsername: organizationMembers.providerUsername,
          role: organizationMembers.role,
          createdAt: organizationMembers.createdAt,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organization.id),
            isNull(organizationMembers.removedAt)
          )
        )
        .orderBy(
          sql`CASE ${organizationMembers.role} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END`,
          asc(organizationMembers.createdAt)
        );

      return c.json({
        members: members.map((m) => ({
          id: m.id,
          user_id: m.userId,
          username: m.providerUsername,
          role: m.role,
          joined_at: m.createdAt.toISOString(),
        })),
      });
    } finally {
      await client.end();
    }
  }
);

export default app;
