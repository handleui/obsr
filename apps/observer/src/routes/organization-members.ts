/**
 * Organization Members API routes
 *
 * SECURITY MODEL: GitHub is the access gate, Detent DB is authorization.
 * - GitHub membership is verified on-demand via GitHub API (can you enter?)
 * - Roles are read from organization_members table (what can you do?)
 *
 * The vulnerable /join endpoint has been REMOVED. Users access orgs by:
 * 1. Being a member of the GitHub org (verified on each request)
 * 2. Having their GitHub identity linked via WorkOS OAuth
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  type OrgAccessRole,
  requireRole,
} from "../middleware/github-org-access";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

const VALID_ROLES: OrgAccessRole[] = ["owner", "admin", "member", "visitor"];

/**
 * POST /leave
 * Leave an organization - removes user's Detent-specific record
 * Note: This doesn't remove them from the GitHub org, just clears Detent data
 */
app.post("/leave", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json<{ organization_id: string }>();
  const { organization_id: organizationId } = body;

  if (!organizationId) {
    return c.json({ error: "organization_id is required" }, 400);
  }

  const convex = getConvexClient(c.env);
  const result = (await convex.mutation(
    "organization_members:leaveOrganization",
    {
      organizationId,
      userId: auth.userId,
      removedBy: auth.userId,
    }
  )) as { error?: string; code?: string; status?: number; success?: boolean };

  if (result.error) {
    return c.json(
      { error: result.error, ...(result.code && { code: result.code }) },
      (result.status ?? 400) as 400
    );
  }

  return c.json(result);
});

/**
 * GET /:orgId/members
 * List members of an organization
 * Uses on-demand GitHub membership verification via middleware
 */
app.get("/:orgId/members", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization, githubIdentity, role } = orgAccess;

  const convex = getConvexClient(c.env);
  const detentMembers = (await convex.query("organization_members:listByOrg", {
    organizationId: organization._id,
  })) as Array<{
    userId: string;
    role: OrgAccessRole;
    providerUserId?: string;
    providerUsername?: string;
    createdAt: number;
  }>;

  return c.json({
    current_user: {
      user_id: c.get("auth").userId,
      github_user_id: githubIdentity.userId,
      github_username: githubIdentity.username,
      role,
      is_installer: organization.installerGithubId === githubIdentity.userId,
    },
    // Detent-specific records (may not include all GitHub org members)
    detent_members: detentMembers.map((m) => ({
      user_id: m.userId,
      role: m.role,
      github_user_id: m.providerUserId,
      github_username: m.providerUsername,
      github_linked: Boolean(m.providerUserId),
      joined_at: new Date(m.createdAt).toISOString(),
    })),
    // Note: For a full list of GitHub org members, query GitHub API directly
    note: "This list shows Detent users who have accessed this org. GitHub org membership is verified on-demand.",
  });
});

/**
 * GET /:orgId/me
 * Get current user's access to an organization
 * Verifies GitHub membership on-demand
 */
app.get("/:orgId/me", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization, githubIdentity, role } = orgAccess;
  const auth = c.get("auth");

  const convex = getConvexClient(c.env);
  const detentRecord = (await convex.query(
    "organization_members:getByOrgUser",
    {
      organizationId: organization._id,
      userId: auth.userId,
    }
  )) as {
    _id: string;
    providerUserId?: string;
    providerUsername?: string;
    removedAt?: number;
  } | null;

  if (!detentRecord || detentRecord.removedAt) {
    await convex.mutation("organization_members:createIfMissing", {
      organizationId: organization._id,
      userId: auth.userId,
      role,
      providerUserId: githubIdentity.userId,
      providerUsername: githubIdentity.username,
      providerLinkedAt: Date.now(),
    });
  } else if (
    detentRecord.providerUserId !== githubIdentity.userId ||
    detentRecord.providerUsername !== githubIdentity.username
  ) {
    await convex.mutation("organization_members:update", {
      id: detentRecord._id,
      providerUserId: githubIdentity.userId,
      providerUsername: githubIdentity.username,
      providerLinkedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return c.json({
    organization_id: organization._id,
    organization_name: organization.name,
    organization_slug: organization.slug,
    role,
    github_user_id: githubIdentity.userId,
    github_username: githubIdentity.username,
    is_installer: organization.installerGithubId === githubIdentity.userId,
    provider: organization.provider,
    provider_account: organization.providerAccountLogin,
  });
});

/**
 * PUT /:orgId/members/:userId/role
 * Update a member's role in the organization
 *
 * SECURITY: Role-based permission hierarchy:
 * - Owners can: promote anyone to any role, demote anyone except last owner
 * - Admins can: promote members to admin, demote admins to member
 * - Admins CANNOT: promote anyone to owner, demote owners
 */
app.put(
  "/:orgId/members/:userId/role",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization, role: actorRole } = orgAccess;
    const auth = c.get("auth");
    const targetUserId = c.req.param("userId");

    // Parse request body
    const body = await c.req.json<{ role: string }>();
    const { role: newRole } = body;

    // Validate role
    if (!(newRole && VALID_ROLES.includes(newRole as OrgAccessRole))) {
      return c.json(
        {
          error: "Invalid role",
          valid_roles: VALID_ROLES,
        },
        400
      );
    }

    // Cannot change your own role
    if (targetUserId === auth.userId) {
      return c.json(
        {
          error: "Cannot change your own role",
        },
        400
      );
    }

    const convex = getConvexClient(c.env);
    const result = (await convex.mutation("organization_members:updateRole", {
      organizationId: organization._id,
      targetUserId,
      actorRole,
      newRole: newRole as OrgAccessRole,
    })) as {
      error?: string;
      message?: string;
      status?: number;
      success?: boolean;
      old_role?: string;
      new_role?: string;
    };

    if (result.error && result.status) {
      const { status, ...errorBody } = result;
      const responseStatus = status as 400 | 401 | 403 | 404 | 409 | 500;
      return c.json(errorBody, responseStatus);
    }

    if (!result.success) {
      return c.json({ error: "Role update failed" }, 500);
    }

    console.log(
      `[role-update] ${auth.userId} (${actorRole}) changed ${targetUserId} role from ${result.old_role} to ${result.new_role} in ${organization.slug}`
    );

    return c.json(result);
  }
);

/**
 * GET /by-org/:orgId
 * Legacy endpoint - redirect to new pattern
 */
app.get("/by-org/:orgId", (c) => {
  const orgId = c.req.param("orgId");
  return c.redirect(`/v1/organization-members/${orgId}/members`, 301);
});

export default app;
