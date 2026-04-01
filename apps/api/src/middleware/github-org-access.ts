import type { Context, Next } from "hono";
import type { ObserverClient } from "../db/client";
import { getDbClient } from "../db/client";
import { getVerifiedGitHubIdentity } from "../lib/github-identity";
import { verifyGitHubMembership } from "../lib/github-membership";
import type { OrganizationSettings } from "../lib/org-settings";
import type { Env } from "../types/env";
// Import auth middleware to ensure type extensions are merged
import "../middleware/auth";

// Role assigned based on GitHub membership + installer status
export type OrgAccessRole = "owner" | "admin" | "member" | "visitor";

interface GitHubIdentity {
  userId: string;
  username: string;
}

interface OrganizationDoc {
  _id: string;
  slug: string;
  name: string;
  provider: "github" | "gitlab";
  providerAccountLogin: string;
  providerAccountId: string;
  providerAccountType: "organization" | "user";
  providerInstallationId?: string;
  installerGithubId?: string;
  settings?: OrganizationSettings | null;
  deletedAt?: number;
  suspendedAt?: number;
}

interface OrganizationMemberDoc {
  _id: string;
  organizationId: string;
  userId: string;
  role: OrgAccessRole;
  membershipSource?: string;
  providerUserId?: string;
  providerUsername?: string;
  providerVerifiedAt?: number;
  removedAt?: number;
}

const GITHUB_MANAGED_MEMBERSHIP_SOURCES = new Set([
  "github_access",
  "github_sync",
  "github_webhook",
  "installer",
]);
const GITHUB_MEMBERSHIP_REVALIDATION_INTERVAL_MS = 10 * 60 * 1000;

const shouldRevalidateGitHubMembership = (
  member: OrganizationMemberDoc,
  now: number
): boolean => {
  if (!member.membershipSource) {
    return false;
  }
  if (!GITHUB_MANAGED_MEMBERSHIP_SOURCES.has(member.membershipSource)) {
    return false;
  }
  if (!member.providerVerifiedAt) {
    return true;
  }
  return (
    now - member.providerVerifiedAt >=
    GITHUB_MEMBERSHIP_REVALIDATION_INTERVAL_MS
  );
};

export interface OrgAccessContext {
  organization: {
    _id: string;
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
  dbClient: ObserverClient,
  org: OrganizationDoc,
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
    const owners = (await dbClient.query("organization_members:listByOrgRole", {
      organizationId: org._id,
      role: "owner",
    })) as OrganizationMemberDoc[];
    const ownerCount = owners.filter((owner) => !owner.removedAt).length;

    // If no active owner exists, this admin becomes owner
    // Security: Only GitHub admins can become owners (not regular members who installed)
    if (ownerCount === 0) {
      return "owner";
    }
    return "admin";
  }

  // Regular GitHub members get member role (even if they installed the app)
  return "member";
};

const getActiveMember = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  userId: string
): Promise<OrganizationMemberDoc | null> => {
  const existingMember = (await dbClient.query(
    "organization_members:getByOrgUser",
    {
      organizationId: org._id,
      userId,
    }
  )) as OrganizationMemberDoc | null;
  return existingMember && !existingMember.removedAt ? existingMember : null;
};

const syncActiveMemberIdentity = async (
  dbClient: ObserverClient,
  activeMember: OrganizationMemberDoc,
  githubIdentity: GitHubIdentity,
  now: number
): Promise<void> => {
  if (
    activeMember.providerUserId === githubIdentity.userId &&
    activeMember.providerUsername === githubIdentity.username
  ) {
    return;
  }

  await dbClient.mutation("organization_members:update", {
    id: activeMember._id,
    providerUserId: githubIdentity.userId,
    providerUsername: githubIdentity.username,
    providerLinkedAt: now,
    updatedAt: now,
  });
};

const revalidateActiveGitHubMembership = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  activeMember: OrganizationMemberDoc,
  githubIdentity: GitHubIdentity,
  env: Env,
  now: number
): Promise<{ error: string; status: number } | null> => {
  if (!shouldRevalidateGitHubMembership(activeMember, now)) {
    return null;
  }

  const installationId = org.providerInstallationId;
  if (!installationId) {
    return null;
  }

  try {
    const membership = await verifyGitHubMembership(
      githubIdentity.username,
      org.providerAccountLogin,
      installationId,
      env
    );

    if (!(membership.permissionDenied || membership.isMember)) {
      await dbClient.mutation("organization_members:update", {
        id: activeMember._id,
        removedAt: now,
        removalReason: "github_left",
        removedBy: null,
        updatedAt: now,
      });

      return {
        error: "You are not a member of this GitHub organization",
        status: 403,
      };
    }

    if (membership.isMember) {
      await dbClient.mutation("organization_members:update", {
        id: activeMember._id,
        providerVerifiedAt: now,
        updatedAt: now,
      });
    }
  } catch (error) {
    console.warn(
      `[org-access] Membership revalidation failed for ${githubIdentity.username}@${org.providerAccountLogin}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  return null;
};

const resolveExistingActiveMemberRole = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  activeMember: OrganizationMemberDoc,
  githubIdentity: GitHubIdentity,
  env: Env
): Promise<{ role: OrgAccessRole } | { error: string; status: number }> => {
  const now = Date.now();
  await syncActiveMemberIdentity(dbClient, activeMember, githubIdentity, now);

  const membershipError = await revalidateActiveGitHubMembership(
    dbClient,
    org,
    activeMember,
    githubIdentity,
    env,
    now
  );

  if (membershipError) {
    return membershipError;
  }

  return { role: activeMember.role };
};

const resolveNewMemberRole = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  userId: string,
  githubIdentity: GitHubIdentity,
  env: Env
): Promise<{ role: OrgAccessRole } | { error: string; status: number }> => {
  const installationId = org.providerInstallationId;
  if (!installationId) {
    return {
      error: "GitHub App not installed for this organization",
      status: 400,
    };
  }

  // Only verify membership via GitHub for NEW members trying to auto-join
  const membership = await verifyGitHubMembership(
    githubIdentity.username,
    org.providerAccountLogin,
    installationId,
    env
  );

  // App lacks members:read permission - can't auto-join, need manual invite
  if (membership.permissionDenied) {
    return {
      error:
        "Cannot verify GitHub membership automatically. Please ask an organization admin to invite you.",
      status: 403,
    };
  }

  if (!membership.isMember) {
    return {
      error: "You are not a member of this GitHub organization",
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
    dbClient,
    org,
    membership.role ?? "member"
  );

  const createdMember = (await dbClient.mutation(
    "organization_members:createIfMissing",
    {
      organizationId: org._id,
      userId,
      role: intendedRole,
      membershipSource: "github_access",
      providerUserId: githubIdentity.userId,
      providerUsername: githubIdentity.username,
      providerLinkedAt: Date.now(),
    }
  )) as OrganizationMemberDoc | null;

  const actualMember =
    createdMember && !createdMember.removedAt ? createdMember : null;

  if (!actualMember) {
    // Shouldn't happen, but handle gracefully
    console.error(
      `[org-access] Race condition: insert conflict but no member found for ${userId} in ${org._id}`
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

// Handle GitHub organization membership check and role determination
const resolveGitHubOrgRole = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  userId: string,
  githubIdentity: GitHubIdentity,
  env: Env
): Promise<{ role: OrgAccessRole } | { error: string; status: number }> => {
  const activeMember = await getActiveMember(dbClient, org, userId);
  if (activeMember) {
    return resolveExistingActiveMemberRole(
      dbClient,
      org,
      activeMember,
      githubIdentity,
      env
    );
  }

  return resolveNewMemberRole(dbClient, org, userId, githubIdentity, env);
};

const loadOrganization = async (
  dbClient: ObserverClient,
  orgIdOrSlug: string,
  c: Context<{ Bindings: Env }>
): Promise<OrganizationDoc | Response> => {
  const org = (
    orgIdOrSlug.includes("/")
      ? await dbClient.query("organizations:getBySlug", { slug: orgIdOrSlug })
      : await dbClient.query("organizations:getById", { id: orgIdOrSlug })
  ) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  if (org.suspendedAt) {
    return c.json({ error: "Organization is suspended" }, 403);
  }

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

  return org;
};

const resolveGitHubIdentityForOrg = async (
  userId: string,
  activeMember: OrganizationMemberDoc | null,
  env: Env
): Promise<GitHubIdentity | null> => {
  const githubIdentity = await getVerifiedGitHubIdentity(userId, env);

  if (
    !githubIdentity &&
    activeMember?.providerUserId &&
    activeMember.providerUsername
  ) {
    return {
      userId: activeMember.providerUserId,
      username: activeMember.providerUsername,
    };
  }

  return githubIdentity;
};

const resolveOrgAccessRole = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  userId: string,
  githubIdentity: GitHubIdentity,
  env: Env,
  c: Context<{ Bindings: Env }>
): Promise<OrgAccessRole | Response> => {
  if (org.providerAccountType === "user") {
    if (githubIdentity.userId !== org.providerAccountId) {
      return c.json(
        {
          error: "Access denied",
          message: "You are not the owner of this GitHub account",
        },
        403
      );
    }
    return "owner";
  }

  const result = await resolveGitHubOrgRole(
    dbClient,
    org,
    userId,
    githubIdentity,
    env
  );

  if ("error" in result) {
    return c.json({ error: "Access denied", message: result.error }, 403);
  }

  return result.role;
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
  const dbClient = getDbClient(c.env);
  try {
    const orgResult = await loadOrganization(dbClient, orgIdOrSlug, c);
    if (orgResult instanceof Response) {
      return orgResult;
    }
    const org = orgResult;

    // Check for existing membership with stored GitHub identity (active members only)
    const existingMember = (await dbClient.query(
      "organization_members:getByOrgUser",
      { organizationId: org._id, userId: auth.userId }
    )) as OrganizationMemberDoc | null;
    const activeMember =
      existingMember && !existingMember.removedAt ? existingMember : null;

    const githubIdentity = await resolveGitHubIdentityForOrg(
      auth.userId,
      activeMember,
      c.env
    );

    if (!githubIdentity) {
      return c.json(
        {
          error: "GitHub account not linked",
          code: "GITHUB_NOT_LINKED",
          message: "Please link your GitHub account to access organizations",
        },
        403
      );
    }

    const roleResult = await resolveOrgAccessRole(
      dbClient,
      org,
      auth.userId,
      githubIdentity,
      c.env,
      c
    );
    if (roleResult instanceof Response) {
      return roleResult;
    }
    const role = roleResult;

    // Set context for downstream handlers
    const orgAccess: OrgAccessContext = {
      organization: {
        _id: org._id,
        slug: org.slug,
        name: org.name,
        provider: org.provider,
        providerAccountLogin: org.providerAccountLogin,
        providerAccountType: org.providerAccountType,
        providerInstallationId: org.providerInstallationId ?? null,
        installerGithubId: org.installerGithubId ?? null,
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
  } catch (error) {
    console.error(
      "[org-access] Failed to verify organization access:",
      error instanceof Error ? error.message : String(error)
    );
    return c.json({ error: "Failed to verify organization access" }, 500);
  }
};

// Helper to require specific roles
// SECURITY: Does not expose the user's current role in error responses
// to prevent information disclosure that could aid privilege escalation
// BREAKING CHANGE: Previously returned { required, current } fields in 403 response.
// These were removed to prevent role enumeration attacks. Internal clients should
// not parse role info from error responses - use the orgAccess context directly.
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
      // Log the actual role for debugging but don't expose in response
      console.log(
        `[requireRole] Access denied: ${orgAccess.githubIdentity.username} has ${orgAccess.role} role, needs one of: ${allowedRoles.join(", ")}`
      );
      return c.json(
        {
          error: "Insufficient permissions",
          message: "You do not have the required role to perform this action",
        },
        403
      );
    }

    await next();
    return undefined;
  };
