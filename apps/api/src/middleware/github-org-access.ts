import { and, count, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Context, Next } from "hono";
import { createDb } from "../db/client";
import type * as schema from "../db/schema";
import {
  getOrgSettings,
  type Organization,
  type OrganizationSettings,
  organizationMembers,
  organizations,
} from "../db/schema";
import { getVerifiedGitHubIdentity } from "../lib/github-identity";
import { verifyGitHubMembership } from "../lib/github-membership";
import type { Env } from "../types/env";
// Import auth middleware to ensure type extensions are merged
import "../middleware/auth";

// Role assigned based on GitHub membership + installer status
export type OrgAccessRole = "owner" | "admin" | "member";

interface GitHubIdentity {
  userId: string;
  username: string;
}

export interface OrgAccessContext {
  organization: {
    id: string;
    slug: string;
    name: string;
    provider: "github" | "gitlab";
    providerAccountLogin: string;
    providerAccountType: "organization" | "user";
    providerInstallationId: string | null;
    installerGithubId: string | null;
    settings: OrganizationSettings;
  };
  githubIdentity: GitHubIdentity;
  role: OrgAccessRole;
}

// Extend Hono context to include orgAccess
declare module "hono" {
  interface ContextVariableMap {
    orgAccess: OrgAccessContext;
  }
}

// Determine initial role for new members based on GitHub state
// For GitHub admins on ownerless orgs: first come, first serve - they become owner
//
// SECURITY: This function only determines the INTENDED role. The actual insert
// uses ON CONFLICT to prevent race conditions from creating duplicate owners.
// See resolveGitHubOrgRole for the atomic insert with conflict handling.
const seedRoleFromGitHub = async (
  db: NodePgDatabase<typeof schema>,
  org: Organization,
  githubRole: "admin" | "member"
): Promise<OrgAccessRole> => {
  // For GitHub admins: check if org has any existing owners
  // First admin on an ownerless org becomes owner (first come, first serve)
  // Installer who is also a GitHub admin gets priority as owner
  // NOTE: Race condition between check and insert is mitigated by:
  // 1. The unique constraint on (organizationId, userId) prevents duplicates
  // 2. If multiple admins race, only one can win the owner slot due to
  //    the recheck after insert (see resolveGitHubOrgRole)
  if (githubRole === "admin") {
    const ownerCountResult = await db
      .select({ count: count() })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, org.id),
          eq(organizationMembers.role, "owner")
        )
      );

    // If no owner exists, this admin becomes owner
    // Security: Only GitHub admins can become owners (not regular members who installed)
    if (ownerCountResult[0]?.count === 0) {
      return "owner";
    }
    return "admin";
  }

  // Regular GitHub members get member role (even if they installed the app)
  return "member";
};

// Handle GitHub organization membership check and role determination
const resolveGitHubOrgRole = async (
  db: NodePgDatabase<typeof schema>,
  org: Organization,
  userId: string,
  githubIdentity: GitHubIdentity,
  env: Env
): Promise<{ role: OrgAccessRole } | { error: string; status: number }> => {
  // Check for existing Detent membership first
  const existingMember = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.organizationId, org.id)
    ),
  });

  // Verify membership via GitHub API (access gate)
  const membership = await verifyGitHubMembership(
    githubIdentity.username,
    org.providerAccountLogin,
    org.providerInstallationId as string,
    env
  );

  if (!membership.isMember) {
    return {
      error: "You are not a member of this GitHub organization",
      status: 403,
    };
  }

  if (existingMember) {
    // Existing member: use DB role for authorization
    // Update GitHub identity if changed
    if (
      existingMember.providerUserId !== githubIdentity.userId ||
      existingMember.providerUsername !== githubIdentity.username
    ) {
      await db
        .update(organizationMembers)
        .set({
          providerUserId: githubIdentity.userId,
          providerUsername: githubIdentity.username,
          providerLinkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(organizationMembers.id, existingMember.id));
    }
    return { role: existingMember.role };
  }

  // New member: check if auto-join is allowed
  const settings = getOrgSettings(org.settings);
  if (!settings.allowAutoJoin) {
    return {
      error: "Organization requires invitation to join",
      status: 403,
    };
  }

  // New member: seed role from GitHub, then create record
  // SECURITY: Race condition mitigation for "first admin becomes owner":
  // 1. seedRoleFromGitHub determines intended role based on current state
  // 2. Insert with onConflictDoNothing handles concurrent inserts
  // 3. If insert was skipped due to conflict, fetch the actual record
  // 4. If we tried to become owner but someone else won, we stay as admin
  const intendedRole = await seedRoleFromGitHub(
    db,
    org,
    membership.role ?? "member"
  );

  const memberId = crypto.randomUUID();
  const insertResult = await db
    .insert(organizationMembers)
    .values({
      id: memberId,
      organizationId: org.id,
      userId,
      role: intendedRole,
      providerUserId: githubIdentity.userId,
      providerUsername: githubIdentity.username,
      providerLinkedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [organizationMembers.organizationId, organizationMembers.userId],
    })
    .returning({ id: organizationMembers.id, role: organizationMembers.role });

  // If insert succeeded, return the intended role
  if (insertResult.length > 0) {
    return { role: intendedRole };
  }

  // Insert was skipped due to conflict - another request beat us
  // Fetch the actual record that was inserted by the other request
  const actualMember = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.organizationId, org.id)
    ),
  });

  if (!actualMember) {
    // Shouldn't happen, but handle gracefully
    console.error(
      `[org-access] Race condition: insert conflict but no member found for ${userId} in ${org.id}`
    );
    return {
      error: "Failed to create membership record",
      status: 500,
    };
  }

  // Return the actual role from the winning insert
  // If we intended "owner" but got "admin", that's correct - someone else won the race
  if (intendedRole === "owner" && actualMember.role !== "owner") {
    console.log(
      `[org-access] Race condition resolved: ${githubIdentity.username} intended owner but got ${actualMember.role} in ${org.slug}`
    );
  }

  return { role: actualMember.role };
};

// Middleware that verifies GitHub org membership on-demand
// Sets "orgAccess" in context with verified role
export const githubOrgAccessMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const auth = c.get("auth");
  if (!auth?.userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  // Get org identifier from path params
  const orgIdOrSlug = c.req.param("orgId") || c.req.param("organizationId");
  if (!orgIdOrSlug) {
    return c.json({ error: "Organization identifier required" }, 400);
  }

  // Fetch organization
  const { db, client } = await createDb(c.env);
  try {
    const org = await db.query.organizations.findFirst({
      where: and(
        // Match by ID or slug
        orgIdOrSlug.includes("/")
          ? eq(organizations.slug, orgIdOrSlug)
          : eq(organizations.id, orgIdOrSlug),
        isNull(organizations.deletedAt)
      ),
    });

    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (org.suspendedAt) {
      return c.json({ error: "Organization is suspended" }, 403);
    }

    // Only GitHub orgs supported for now (GitLab uses different auth)
    if (org.provider !== "github") {
      return c.json(
        { error: "GitLab organizations use token-based access" },
        400
      );
    }

    if (!org.providerInstallationId) {
      return c.json(
        { error: "GitHub App not installed for this organization" },
        400
      );
    }

    // Check for existing membership with stored GitHub identity
    const existingMember = await db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, auth.userId),
        eq(organizationMembers.organizationId, org.id)
      ),
    });

    // Try WorkOS for GitHub identity first
    let githubIdentity = await getVerifiedGitHubIdentity(
      auth.userId,
      c.env.WORKOS_API_KEY
    );

    // Fall back to stored identity from membership record
    if (!githubIdentity && existingMember?.providerUserId) {
      githubIdentity = {
        userId: existingMember.providerUserId,
        username: existingMember.providerUsername ?? "",
      };
    }

    if (!githubIdentity) {
      return c.json(
        {
          error: "GitHub account not linked",
          code: "GITHUB_NOT_LINKED",
          message:
            "Please link your GitHub account via WorkOS to access organizations",
        },
        403
      );
    }

    // Determine role based on org type
    let role: OrgAccessRole;

    if (org.providerAccountType === "user") {
      // Personal GitHub account: only the owner can access
      if (githubIdentity.userId !== org.providerAccountId) {
        return c.json(
          {
            error: "Access denied",
            message: "You are not the owner of this GitHub account",
          },
          403
        );
      }
      role = "owner";
    } else {
      // GitHub Organization: resolve role via DB or GitHub
      const result = await resolveGitHubOrgRole(
        db,
        org,
        auth.userId,
        githubIdentity,
        c.env
      );

      if ("error" in result) {
        return c.json({ error: "Access denied", message: result.error }, 403);
      }
      role = result.role;
    }

    // Set context for downstream handlers
    const orgAccess: OrgAccessContext = {
      organization: {
        id: org.id,
        slug: org.slug,
        name: org.name,
        provider: org.provider,
        providerAccountLogin: org.providerAccountLogin,
        providerAccountType: org.providerAccountType,
        providerInstallationId: org.providerInstallationId,
        installerGithubId: org.installerGithubId,
        settings: org.settings ?? {},
      },
      githubIdentity,
      role,
    };

    c.set("orgAccess", orgAccess);

    console.log(
      `[org-access] ${githubIdentity.username} has ${role} access to ${org.slug}`
    );

    await next();
    return undefined;
  } finally {
    await client.end();
  }
};

// Helper to require specific roles
export const requireRole =
  (...allowedRoles: OrgAccessRole[]) =>
  async (
    c: Context<{ Bindings: Env }>,
    next: Next
  ): Promise<Response | undefined> => {
    const orgAccess = c.get("orgAccess");
    if (!orgAccess) {
      return c.json({ error: "Organization access not verified" }, 500);
    }

    if (!allowedRoles.includes(orgAccess.role)) {
      return c.json(
        {
          error: "Insufficient permissions",
          required: allowedRoles,
          current: orgAccess.role,
        },
        403
      );
    }

    await next();
    return undefined;
  };
