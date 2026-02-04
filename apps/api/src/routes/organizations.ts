/**
 * Organizations API routes
 *
 * Handles organization-specific operations like status and details.
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { cacheKey, deleteFromCache } from "../lib/cache";
import { fetchAllPages } from "../lib/convex-pagination";
import { getOrgSettings, type OrganizationSettings } from "../lib/org-settings";
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

type DbClient = ReturnType<typeof getConvexClient>;

interface OrganizationMemberDoc {
  _id: string;
  userId: string;
  role: string;
  providerUserId?: string | null;
  providerUsername?: string | null;
  removedAt?: number | null;
  removalReason?: string | null;
}

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
    _id: string;
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
      mirrorRemovedById.set(m.providerUserId, m._id);
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
  convex: DbClient,
  toReactivate: Array<{ id: string; login: string }>
): Promise<void> => {
  if (toReactivate.length === 0) {
    return;
  }

  const now = Date.now();
  for (const member of toReactivate) {
    await convex.mutation("organization_members:update", {
      id: member.id,
      removedAt: null,
      removalReason: null,
      removedBy: null,
      providerUsername: member.login,
      providerVerifiedAt: now,
      updatedAt: now,
    });
  }
};

/**
 * Batch insert new members
 */
const batchInsertMembers = async (
  convex: DbClient,
  organizationId: string,
  toInsert: Array<{ userId: string; ghUserId: string; login: string }>
): Promise<void> => {
  if (toInsert.length === 0) {
    return;
  }

  const now = Date.now();
  for (const entry of toInsert) {
    await convex.mutation("organization_members:createIfMissing", {
      organizationId,
      userId: entry.userId,
      role: "member",
      providerUserId: entry.ghUserId,
      providerUsername: entry.login,
      providerLinkedAt: now,
      providerVerifiedAt: now,
      membershipSource: "github_sync",
    });
  }
};

/**
 * Sync organization members with GitHub.
 * Actively reconciles memberships based on GitHub org membership.
 */
const syncOrganizationMembers = async (
  convex: DbClient,
  organizationId: string,
  githubMembers: GitHubMember[]
): Promise<MemberSyncResult> => {
  // Get existing active Detent members for this org
  const detentMembers = await fetchAllPages<OrganizationMemberDoc>(
    convex,
    "organization_members:paginateByOrg",
    { organizationId, includeRemoved: true }
  );

  const githubMemberIds = new Set(githubMembers.map((m) => String(m.id)));
  const activeMembers = detentMembers.filter((m) => !m.removedAt);
  const detentMemberIds = new Set(
    activeMembers
      .map((m) => m.providerUserId)
      .filter((id): id is string => Boolean(id))
  );

  // Active: in both Detent and GitHub
  const activeMembersInGitHub = activeMembers.filter(
    (m) => m.providerUserId && githubMemberIds.has(m.providerUserId)
  );

  // Potential: in GitHub but not in Detent
  const potentialMembers = githubMembers.filter(
    (m) => !detentMemberIds.has(String(m.id))
  );

  // Stale: in Detent but no longer in GitHub (excluding owners)
  const staleMembers = activeMembers.filter(
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
    const removedMembers = detentMembers
      .filter(
        (member) =>
          member.removedAt &&
          member.providerUserId &&
          potentialGhIds.includes(member.providerUserId)
      )
      .map((member) => ({
        _id: member._id,
        providerUserId: member.providerUserId ?? null,
        removalReason: member.removalReason ?? null,
      }));

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
    for (const member of detentMembers) {
      if (
        member.providerUserId &&
        nonBlockedGhIds.includes(member.providerUserId)
      ) {
        existingUsersByGhId.set(member.providerUserId, member.userId);
      }
    }

    const { toReactivate, toInsert } = categorizePotentialMembers(
      potentialMembers,
      lookups,
      existingUsersByGhId
    );

    await batchReactivateMembers(convex, toReactivate);
    added += toReactivate.length;

    await batchInsertMembers(convex, organizationId, toInsert);
    added += toInsert.length;
  }

  // Soft-delete stale members (not in GitHub, not owners)
  if (staleMembers.length > 0) {
    const now = Date.now();
    for (const member of staleMembers) {
      await convex.mutation("organization_members:update", {
        id: member._id,
        removedAt: now,
        removalReason: "github_left",
        removedBy: "system",
        updatedAt: now,
      });
    }
    removed = staleMembers.length;
  }

  // Update providerVerifiedAt for active members
  if (activeMembersInGitHub.length > 0) {
    const now = Date.now();
    for (const member of activeMembersInGitHub) {
      await convex.mutation("organization_members:update", {
        id: member._id,
        providerVerifiedAt: now,
        updatedAt: now,
      });
    }
  }

  return {
    active: activeMembersInGitHub.length,
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

  const convex = getConvexClient(c.env);

  // Fetch full organization details and project count in parallel
  const [fullOrg, projectCount] = await Promise.all([
    convex.query("organizations:getById", {
      id: organization._id,
    }) as Promise<{
      _id: string;
      name: string;
      slug: string;
      provider: string;
      providerAccountLogin: string;
      providerAccountType: string;
      suspendedAt?: number | null;
      createdAt: number;
      lastSyncedAt?: number | null;
      settings?: OrganizationSettings | null;
    } | null>,
    convex.query("projects:countByOrg", {
      organizationId: organization._id,
    }) as Promise<number>,
  ]);

  if (!fullOrg) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const appInstalled = Boolean(organization.providerInstallationId);
  const settings = getOrgSettings(fullOrg.settings);

  return c.json({
    organization_id: fullOrg._id,
    organization_name: fullOrg.name,
    organization_slug: fullOrg.slug,
    provider: fullOrg.provider,
    provider_account_login: fullOrg.providerAccountLogin,
    provider_account_type: fullOrg.providerAccountType,
    app_installed: appInstalled,
    suspended_at: fullOrg.suspendedAt
      ? new Date(fullOrg.suspendedAt).toISOString()
      : null,
    project_count: projectCount,
    created_at: new Date(fullOrg.createdAt).toISOString(),
    last_synced_at: fullOrg.lastSyncedAt
      ? new Date(fullOrg.lastSyncedAt).toISOString()
      : null,
    settings: {
      enable_inline_annotations: settings.enableInlineAnnotations,
      enable_pr_comments: settings.enablePrComments,
      heal_auto_trigger: settings.healAutoTrigger,
      validation_enabled: settings.validationEnabled,
    },
  });
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
    const organizationId = organization._id;

    // Middleware already verifies: GitHub provider, app installed, not suspended
    const github = createGitHubService(c.env);
    const installationId = Number(organization.providerInstallationId);

    const convex = getConvexClient(c.env);
    try {
      // Fetch full org to get suspendedAt (middleware subset doesn't include it)
      const fullOrg = (await convex.query("organizations:getById", {
        id: organizationId,
      })) as {
        _id: string;
        suspendedAt?: number | null;
      } | null;

      if (!fullOrg) {
        return c.json({ error: "Organization not found" }, 404);
      }

      // 1. Check if installation still exists and get its status
      const installationInfo = await github.getInstallationInfo(installationId);

      if (!installationInfo) {
        // Installation was removed - mark organization as deleted
        await convex.mutation("organizations:update", {
          id: organizationId,
          deletedAt: Date.now(),
          lastSyncedAt: Date.now(),
          updatedAt: Date.now(),
        });

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
        await convex.mutation("organizations:update", {
          id: organizationId,
          suspendedAt: isSuspended
            ? new Date(installationInfo.suspended_at as string).getTime()
            : null,
          updatedAt: Date.now(),
        });
      }

      // 3. Get current repos from GitHub and reconcile with our projects
      const githubRepos = await github.getInstallationRepos(installationId);

      const result = (await convex.mutation("projects:syncFromGitHub", {
        organizationId,
        repos: githubRepos.map((repo) => ({
          id: String(repo.id),
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
        })),
        syncRemoved: true,
      })) as SyncResult;

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
            convex,
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
      await convex.mutation("organizations:update", {
        id: organizationId,
        lastSyncedAt: Date.now(),
        updatedAt: Date.now(),
      });

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
      "heal_auto_trigger",
      "validation_enabled",
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

    const convex = getConvexClient(c.env);

    // Fetch current settings
    const current = (await convex.query("organizations:getById", {
      id: organization._id,
    })) as { settings?: OrganizationSettings | null } | null;

    if (!current) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Merge with new settings (snake_case to camelCase)
    const newSettings: OrganizationSettings = {
      ...(current.settings ?? {}),
      ...(providedSettings.enable_inline_annotations !== undefined && {
        enableInlineAnnotations: providedSettings.enable_inline_annotations,
      }),
      ...(providedSettings.enable_pr_comments !== undefined && {
        enablePrComments: providedSettings.enable_pr_comments,
      }),
    };
    if ("heal_auto_trigger" in providedSettings) {
      newSettings.healAutoTrigger = providedSettings.heal_auto_trigger;
    }
    if ("validation_enabled" in providedSettings) {
      newSettings.validationEnabled = providedSettings.validation_enabled;
    }

    await convex.mutation("organizations:update", {
      id: organization._id,
      settings: newSettings,
      updatedAt: Date.now(),
    });

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
        heal_auto_trigger: finalSettings.healAutoTrigger,
        validation_enabled: finalSettings.validationEnabled,
      },
    });
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

    const convex = getConvexClient(c.env);

    const fresh = (await convex.query("organizations:getById", {
      id: organization._id,
    })) as { deletedAt?: number | null } | null;

    if (!fresh || fresh.deletedAt) {
      return c.json(
        { error: "Organization not found or already deleted" },
        404
      );
    }

    // Soft-delete the organization
    // HACK: organization_members intentionally left intact for potential recovery.
    // Hard-delete should cascade to members via DB constraint or explicit cleanup.
    await convex.mutation("organizations:update", {
      id: organization._id,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

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

    const convex = getConvexClient(c.env);

    const targetMember = (await convex.query(
      "organization_members:getByOrgUser",
      {
        organizationId: organization._id,
        userId: targetUserId,
      }
    )) as { _id: string; role: string; removedAt?: number | null } | null;

    if (!targetMember || targetMember.removedAt) {
      return c.json({ error: "Member not found" }, 404);
    }

    // Cannot remove an owner
    if (targetMember.role === "owner") {
      return c.json(
        {
          error: "Forbidden",
          message:
            "Cannot remove owner. Transfer ownership first or delete the organization.",
        },
        403
      );
    }

    // SECURITY: Admins cannot remove other admins (only owners can)
    // This prevents privilege escalation where an admin removes all other admins
    if (callerRole === "admin" && targetMember.role === "admin") {
      return c.json(
        {
          error: "Forbidden",
          message: "Admins cannot remove other admins. Contact an owner.",
        },
        403
      );
    }

    await convex.mutation("organization_members:update", {
      id: targetMember._id,
      removedAt: Date.now(),
      removalReason: "admin_action",
      removedBy: callerId,
      updatedAt: Date.now(),
    });

    return c.json({
      success: true,
      removed_user_id: targetUserId,
    });
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

    const convex = getConvexClient(c.env);
    const members = (await convex.query("organization_members:listByOrg", {
      organizationId: organization._id,
      limit: 5000,
    })) as Array<{
      _id: string;
      userId: string;
      providerUsername?: string | null;
      role: string;
      createdAt: number;
    }>;

    const roleRank: Record<string, number> = {
      owner: 0,
      admin: 1,
      member: 2,
      visitor: 3,
    };

    members.sort((a, b) => {
      const rankDiff = (roleRank[a.role] ?? 99) - (roleRank[b.role] ?? 99);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return a.createdAt - b.createdAt;
    });

    return c.json({
      members: members.map((m) => ({
        id: m._id,
        user_id: m.userId,
        username: m.providerUsername,
        role: m.role,
        joined_at: new Date(m.createdAt).toISOString(),
      })),
    });
  }
);

export default app;
