/**
 * Organizations API routes
 *
 * Handles organization-specific operations like status and details.
 */

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  getOrgSettings,
  type OrganizationSettings,
  organizations,
  projects,
} from "../db/schema";
import { cacheKey, deleteFromCache } from "../lib/cache";
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
 * Process repos that need to be added or reactivated
 */
const processReposToAdd = async (
  db: DbClient,
  reposToAdd: GitHubRepo[],
  projectsByRepoId: Map<string, ProjectSnapshot>,
  organizationId: string
): Promise<{ added: number; updated: number }> => {
  let added = 0;
  let updated = 0;

  for (const repo of reposToAdd) {
    const existing = projectsByRepoId.get(String(repo.id));
    if (existing?.removedAt) {
      await db
        .update(projects)
        .set({
          removedAt: null,
          providerRepoName: repo.name,
          providerRepoFullName: repo.full_name,
          providerDefaultBranch: repo.default_branch,
          isPrivate: repo.private,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, existing.id));
      updated++;
    } else {
      await db.insert(projects).values({
        id: crypto.randomUUID(),
        organizationId,
        handle: repo.name.toLowerCase(),
        providerRepoId: String(repo.id),
        providerRepoName: repo.name,
        providerRepoFullName: repo.full_name,
        providerDefaultBranch: repo.default_branch,
        isPrivate: repo.private,
      });
      added++;
    }
  }

  return { added, updated };
};

/**
 * Update projects that exist in both GitHub and our DB but have changed
 */
const updateChangedProjects = async (
  db: DbClient,
  githubRepos: GitHubRepo[],
  projectsByRepoId: Map<string, ProjectSnapshot>
): Promise<number> => {
  let updated = 0;

  for (const repo of githubRepos) {
    const existing = projectsByRepoId.get(String(repo.id));
    const hasChanges =
      existing &&
      !existing.removedAt &&
      (existing.providerRepoName !== repo.name ||
        existing.providerRepoFullName !== repo.full_name ||
        existing.isPrivate !== repo.private);

    if (hasChanges && existing) {
      await db
        .update(projects)
        .set({
          providerRepoName: repo.name,
          providerRepoFullName: repo.full_name,
          providerDefaultBranch: repo.default_branch,
          isPrivate: repo.private,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, existing.id));
      updated++;
    }
  }

  return updated;
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
        allow_auto_join: settings.allowAutoJoin,
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

      // 4. Update lastSyncedAt
      await db
        .update(organizations)
        .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));

      return c.json({
        message: "sync completed",
        organization_id: organizationId,
        suspended: isSuspended,
        projects_added: result.added,
        projects_removed: result.removed,
        projects_updated: result.updated,
        total_repos: githubRepos.length,
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
    const { organization, role } = orgAccess;

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
      "allow_auto_join",
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

    // SECURITY: Restrict allow_auto_join to owner/admin only
    // This setting controls who can join the org, so elevated roles should modify it
    if (
      "allow_auto_join" in providedSettings &&
      role !== "owner" &&
      role !== "admin"
    ) {
      return c.json(
        {
          error: "Forbidden",
          message: "Only owners and admins can change allow_auto_join",
        },
        403
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
        ...(providedSettings.allow_auto_join !== undefined && {
          allowAutoJoin: providedSettings.allow_auto_join,
        }),
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
          allow_auto_join: finalSettings.allowAutoJoin,
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

export default app;
