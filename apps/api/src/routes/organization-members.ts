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

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { organizationMembers } from "../db/schema";
import { validateUUID } from "../lib/validation";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  type OrgAccessRole,
  requireRole,
} from "../middleware/github-org-access";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

const VALID_ROLES: OrgAccessRole[] = ["owner", "admin", "member", "visitor"];

// Helper to check admin permission constraints for role changes
const checkAdminRoleConstraints = (
  actorRole: OrgAccessRole,
  oldRole: OrgAccessRole,
  newRole: string
): { error: string; message: string } | null => {
  if (actorRole !== "admin") {
    return null;
  }

  // Admins cannot promote anyone to owner
  if (newRole === "owner") {
    return {
      error: "Insufficient permissions",
      message: "Only owners can promote members to owner",
    };
  }
  // Admins cannot modify owners at all
  if (oldRole === "owner") {
    return {
      error: "Insufficient permissions",
      message: "Only owners can modify other owners",
    };
  }
  return null;
};

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

  const validation = validateUUID(organizationId, "organization_id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    // Use transaction to prevent TOCTOU race conditions
    // All checks and the delete happen atomically
    const result = await db.transaction(async (tx) => {
      // Find the active membership record (if exists)
      const member = await tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, auth.userId),
          eq(organizationMembers.organizationId, organizationId),
          isNull(organizationMembers.removedAt)
        ),
      });

      if (!member) {
        return { success: true, message: "No membership record to remove" };
      }

      // Check if user is the sole active member - must use delete instead
      const memberCountResult = await tx
        .select({ count: count() })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            isNull(organizationMembers.removedAt)
          )
        );

      if (memberCountResult[0]?.count === 1) {
        return {
          error:
            "Cannot leave as the only member. Use `dt org delete` to remove the organization.",
          code: "sole_member",
          status: 400,
        };
      }

      // If user is a Detent owner or admin, check if they're the only elevated member
      if (member.role === "owner" || member.role === "admin") {
        const elevatedCountResult = await tx
          .select({ count: count() })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              inArray(organizationMembers.role, ["owner", "admin"]),
              isNull(organizationMembers.removedAt)
            )
          );

        if (elevatedCountResult[0]?.count === 1) {
          return {
            error: `Cannot leave ${organizationId} as the only owner/admin. Transfer ownership first.`,
            status: 400,
          };
        }
      }

      // Soft-delete the membership record (maintains audit trail)
      // user_left blocks auto-rejoin via webhook, but admin can re-invite
      // If re-invited and in GitHub org, cron will verify them (upgrade to github_sync)
      await tx
        .update(organizationMembers)
        .set({
          removedAt: new Date(),
          removalReason: "user_left",
          removedBy: auth.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(organizationMembers.userId, auth.userId),
            eq(organizationMembers.organizationId, organizationId)
          )
        );

      return { success: true };
    });

    // Handle transaction result
    if ("error" in result) {
      return c.json(
        { error: result.error, ...(result.code && { code: result.code }) },
        result.status as 400
      );
    }

    return c.json(result);
  } finally {
    await client.end();
  }
});

/**
 * GET /:orgId/members
 * List members of an organization
 * Uses on-demand GitHub membership verification via middleware
 */
app.get("/:orgId/members", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization, githubIdentity, role } = orgAccess;

  const { db, client } = await createDb(c.env);
  try {
    // Get Detent-specific member records for this org (active members only)
    const detentMembers = await db.query.organizationMembers.findMany({
      where: and(
        eq(organizationMembers.organizationId, organization.id),
        isNull(organizationMembers.removedAt)
      ),
    });

    // Return the current user's access plus any stored Detent records
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
        joined_at: m.createdAt.toISOString(),
      })),
      // Note: For a full list of GitHub org members, query GitHub API directly
      note: "This list shows Detent users who have accessed this org. GitHub org membership is verified on-demand.",
    });
  } finally {
    await client.end();
  }
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

  const { db, client } = await createDb(c.env);
  try {
    // Check if user has an active Detent record
    const detentRecord = await db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, auth.userId),
        eq(organizationMembers.organizationId, organization.id),
        isNull(organizationMembers.removedAt)
      ),
    });

    // Optionally create/update Detent record for audit purposes
    if (!detentRecord) {
      // First access - create a Detent record
      await db.insert(organizationMembers).values({
        id: crypto.randomUUID(),
        organizationId: organization.id,
        userId: auth.userId,
        role,
        providerUserId: githubIdentity.userId,
        providerUsername: githubIdentity.username,
        providerLinkedAt: new Date(),
      });
    } else if (
      detentRecord.providerUserId !== githubIdentity.userId ||
      detentRecord.providerUsername !== githubIdentity.username
    ) {
      // Update GitHub identity if changed
      await db
        .update(organizationMembers)
        .set({
          providerUserId: githubIdentity.userId,
          providerUsername: githubIdentity.username,
          providerLinkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(organizationMembers.id, detentRecord.id));
    }

    return c.json({
      organization_id: organization.id,
      organization_name: organization.name,
      organization_slug: organization.slug,
      role,
      github_user_id: githubIdentity.userId,
      github_username: githubIdentity.username,
      is_installer: organization.installerGithubId === githubIdentity.userId,
      provider: organization.provider,
      provider_account: organization.providerAccountLogin,
    });
  } finally {
    await client.end();
  }
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

    // Validate target user ID
    const validation = validateUUID(targetUserId, "userId");
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

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

    const { db, client } = await createDb(c.env);
    try {
      // Use transaction to prevent TOCTOU race conditions
      // All checks and the update happen atomically
      const result = await db.transaction(async (tx) => {
        // Find the target member (active members only)
        const targetMember = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.userId, targetUserId),
            eq(organizationMembers.organizationId, organization.id),
            isNull(organizationMembers.removedAt)
          ),
        });

        if (!targetMember) {
          return { error: "Member not found", status: 404 as const };
        }

        const oldRole = targetMember.role;

        // No change needed
        if (oldRole === newRole) {
          return {
            success: true,
            user_id: targetUserId,
            old_role: oldRole,
            new_role: newRole,
          };
        }

        // SECURITY: Enforce role hierarchy for admins
        const adminConstraintError = checkAdminRoleConstraints(
          actorRole,
          oldRole,
          newRole
        );
        if (adminConstraintError) {
          return { ...adminConstraintError, status: 403 as const };
        }

        // If demoting from owner, check if they're the last active owner
        // (different from last owner/admin - we specifically protect last owner)
        if (oldRole === "owner" && newRole !== "owner") {
          const ownerCountResult = await tx
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, organization.id),
                eq(organizationMembers.role, "owner"),
                isNull(organizationMembers.removedAt)
              )
            );

          if (ownerCountResult[0]?.count === 1) {
            return {
              error: "Cannot demote the last owner",
              message:
                "Transfer ownership to another member before demoting yourself",
              status: 400 as const,
            };
          }
        }

        // If demoting from admin to member or visitor, check if they're the last elevated member
        // (ensures org always has at least one owner or admin)
        if (
          oldRole === "admin" &&
          (newRole === "member" || newRole === "visitor")
        ) {
          const elevatedCountResult = await tx
            .select({ count: count() })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, organization.id),
                inArray(organizationMembers.role, ["owner", "admin"]),
                isNull(organizationMembers.removedAt)
              )
            );

          if (elevatedCountResult[0]?.count === 1) {
            return {
              error: "Cannot demote the last admin",
              message: "Promote another member to admin first",
              status: 400 as const,
            };
          }
        }

        // Update the role
        await tx
          .update(organizationMembers)
          .set({
            role: newRole as OrgAccessRole,
            updatedAt: new Date(),
          })
          .where(eq(organizationMembers.id, targetMember.id));

        return {
          success: true,
          user_id: targetUserId,
          old_role: oldRole,
          new_role: newRole,
        };
      });

      // Handle transaction result
      if ("error" in result && "status" in result) {
        const { status, ...errorBody } = result;
        return c.json(errorBody, status);
      }

      console.log(
        `[role-update] ${auth.userId} (${actorRole}) changed ${targetUserId} role from ${result.old_role} to ${result.new_role} in ${organization.slug}`
      );

      return c.json(result);
    } finally {
      await client.end();
    }
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
