/**
 * Invitation API routes
 *
 * Handles organization invitation management:
 * - Creating and sending invitations (org-scoped, owner/admin only)
 * - Listing pending invitations (org-scoped, owner/admin only)
 * - Revoking invitations (org-scoped, owner/admin only)
 * - Getting invitation details (public, for acceptance UI)
 * - Accepting invitations (authenticated, requires GitHub link)
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { generateSecureToken } from "../lib/crypto";
import { getVerifiedGitHubIdentity } from "../lib/github-identity";
import { validateEmail } from "../lib/validation";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { createEmailService } from "../services/email";
import type { Env } from "../types/env";

// 7 days expiration
const INVITATION_EXPIRY_DAYS = 7;

// ============================================================================
// Org-scoped invitation routes (mounted at /orgs/:orgId/invitations)
// ============================================================================

export const orgInvitationsRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /orgs/:orgId/invitations - Create invitation
 * Owner/admin only
 */
orgInvitationsRoutes.post(
  "/",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization, githubIdentity } = orgAccess;
    const auth = c.get("auth");

    const body = await c.req.json<{ email: string; role?: string }>();
    const { email: rawEmail, role = "member" } = body;

    // Validate email
    const emailValidation = validateEmail(rawEmail);
    if (!emailValidation.valid) {
      return c.json({ error: emailValidation.error }, 400);
    }
    const email = rawEmail.trim().toLowerCase();

    // Validate role (only admin, member, or visitor can be invited, not owner)
    if (!["admin", "member", "visitor"].includes(role)) {
      return c.json(
        {
          error:
            "Role must be 'admin', 'member', or 'visitor'. Owners cannot be invited.",
        },
        400
      );
    }

    const convex = getConvexClient(c.env);
    const existingInvitations = (await convex.query(
      "invitations:listByOrgStatus",
      {
        organizationId: organization._id,
        status: "pending",
      }
    )) as Array<{ email: string }>;

    if (existingInvitations.some((inv) => inv.email === email)) {
      return c.json(
        { error: "A pending invitation already exists for this email" },
        409
      );
    }

    // Generate secure token and expiration
    const token = generateSecureToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    // Create invitation
    const invitationId = (await convex.mutation("invitations:create", {
      organizationId: organization._id,
      email,
      role: role as "admin" | "member" | "visitor",
      token,
      status: "pending",
      expiresAt: expiresAt.getTime(),
      invitedBy: auth.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })) as string;

    // Send invitation email
    const appBaseUrl =
      c.env.APP_BASE_URL ?? c.env.NAVIGATOR_BASE_URL ?? "https://detent.sh";
    const acceptUrl = `${appBaseUrl}/invitations/${token}`;
    const emailService = createEmailService(c.env);

    try {
      await emailService.sendInvitationEmail({
        to: email,
        organizationName: organization.name,
        inviterName: githubIdentity.username,
        role,
        acceptUrl,
        expiresAt,
      });
    } catch (emailError) {
      // Rollback invitation if email fails
      await convex.mutation("invitations:remove", { id: invitationId });
      console.error("[invitations] Email send failed:", emailError);
      return c.json({ error: "Failed to send invitation email" }, 500);
    }

    console.log(
      `[invitations] Created invitation for ${email} to ${organization.slug} as ${role}`
    );

    return c.json(
      {
        id: invitationId,
        email,
        role,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      },
      201
    );
  }
);

/**
 * GET /orgs/:orgId/invitations - List pending invitations
 * Owner/admin only
 */
orgInvitationsRoutes.get(
  "/",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const convex = getConvexClient(c.env);
    const pendingInvitations = (await convex.query(
      "invitations:listByOrgStatus",
      {
        organizationId: organization._id,
        status: "pending",
      }
    )) as Array<{
      _id: string;
      email: string;
      role: string;
      invitedBy: string;
      expiresAt: number;
      createdAt: number;
    }>;

    // Filter out expired invitations (they're still "pending" in DB but functionally expired)
    const now = Date.now();
    const activeInvitations = pendingInvitations.filter(
      (inv) => inv.expiresAt > now
    );

    return c.json({
      invitations: activeInvitations.map((inv) => ({
        id: inv._id,
        email: inv.email,
        role: inv.role,
        invited_by: inv.invitedBy,
        expires_at: new Date(inv.expiresAt).toISOString(),
        created_at: new Date(inv.createdAt).toISOString(),
      })),
    });
  }
);

/**
 * DELETE /orgs/:orgId/invitations/:invitationId - Revoke invitation
 * Owner/admin only
 */
orgInvitationsRoutes.delete(
  "/:invitationId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const auth = c.get("auth");
    const invitationId = c.req.param("invitationId");

    const convex = getConvexClient(c.env);
    const invitation = (await convex.query("invitations:getById", {
      id: invitationId,
    })) as {
      _id: string;
      organizationId: string;
      status: string;
      email: string;
    } | null;

    if (!invitation || invitation.organizationId !== organization._id) {
      return c.json({ error: "Invitation not found" }, 404);
    }

    if (invitation.status !== "pending") {
      return c.json(
        {
          error: `Cannot revoke invitation with status '${invitation.status}'`,
        },
        400
      );
    }

    await convex.mutation("invitations:update", {
      id: invitationId,
      status: "revoked",
      revokedAt: Date.now(),
      revokedBy: auth.userId,
      updatedAt: Date.now(),
    });

    console.log(
      `[invitations] Revoked invitation ${invitationId} for ${invitation.email}`
    );

    return c.json({ success: true });
  }
);

// ============================================================================
// Standalone invitation routes (mounted at /invitations)
// ============================================================================

export const invitationRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /invitations/:token - Get invitation details (public)
 * Used by the acceptance UI to display invitation info
 */
invitationRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");

  const convex = getConvexClient(c.env);
  const invitation = (await convex.query("invitations:getByToken", {
    token,
  })) as {
    organizationId: string;
    status: string;
    expiresAt: number;
    role: string;
    email: string;
  } | null;

  if (!invitation) {
    return c.json({ error: "Invitation not found" }, 404);
  }

  // Check status
  if (invitation.status === "accepted") {
    return c.json(
      {
        error: "This invitation has already been accepted",
        code: "ACCEPTED",
      },
      410
    );
  }

  if (invitation.status === "revoked") {
    return c.json(
      { error: "This invitation has been revoked", code: "REVOKED" },
      410
    );
  }

  if (invitation.status === "expired" || invitation.expiresAt < Date.now()) {
    return c.json(
      { error: "This invitation has expired", code: "EXPIRED" },
      410
    );
  }

  const organization = (await convex.query("organizations:getById", {
    id: invitation.organizationId,
  })) as { name: string; slug: string } | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Return public info (no sensitive data)
  return c.json({
    organization_name: organization.name,
    organization_slug: organization.slug,
    role: invitation.role,
    expires_at: new Date(invitation.expiresAt).toISOString(),
    email: invitation.email,
  });
});

/**
 * POST /invitations/accept - Accept invitation
 * Requires authentication and GitHub identity linked
 */
invitationRoutes.post("/accept", async (c) => {
  // Manual auth check since this route needs special handling
  const auth = c.get("auth");
  if (!auth?.userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const body = await c.req.json<{ token: string }>();
  const { token } = body;

  if (!token) {
    return c.json({ error: "Token is required" }, 400);
  }

  const convex = getConvexClient(c.env);

  // Verify GitHub identity is linked
  const githubIdentity = await getVerifiedGitHubIdentity(
    auth.userId,
    c.env.WORKOS_API_KEY
  );

  if (!githubIdentity) {
    return c.json(
      {
        error: "GitHub account not linked",
        code: "GITHUB_NOT_LINKED",
        message:
          "Please link your GitHub account before accepting the invitation",
      },
      403
    );
  }

  const result = (await convex.mutation("invitations:accept", {
    token,
    userId: auth.userId,
    githubUserId: githubIdentity.userId,
    githubUsername: githubIdentity.username,
  })) as {
    error?: string;
    status?: number;
    success?: boolean;
    organizationId?: string;
    role?: string;
  };

  if (result.error) {
    const status = (result.status ?? 400) as 400 | 401 | 403 | 404 | 409 | 500;
    return c.json({ error: result.error }, status);
  }

  if (!(result.success && result.organizationId)) {
    return c.json({ error: "Failed to accept invitation" }, 500);
  }

  const organization = (await convex.query("organizations:getById", {
    id: result.organizationId,
  })) as { name: string; slug: string } | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  console.log(
    `[invitations] ${githubIdentity.username} accepted invitation to ${organization.slug} as ${result.role}`
  );

  return c.json({
    success: true,
    organization_id: result.organizationId,
    organization_name: organization.name,
    organization_slug: organization.slug,
    role: result.role,
  });
});

export default invitationRoutes;
