/**
 * Organization access verification utilities
 *
 * Verifies user access to organizations via real-time GitHub membership checks.
 * Used across multiple routes to ensure consistent access control.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { organizationMembers } from "../db/schema";
import type { Env } from "../types/env";
import { getVerifiedGitHubIdentity } from "./github-identity";
import { verifyGitHubMembership } from "./github-membership";

/**
 * Minimal org shape required for verification.
 * Can be satisfied by organization records or project.organization relations.
 */
export interface OrgForVerification {
  id: string;
  provider: string;
  providerAccountLogin: string;
  providerInstallationId: string | null;
  providerAccountType: string;
  providerAccountId: string;
  installerGithubId: string | null;
}

export interface OrgAccessResult {
  allowed: boolean;
  role?: "owner" | "admin" | "member" | "visitor";
  error?: string;
}

interface GitHubIdentity {
  userId: string;
  username: string;
}

/**
 * Verify user has access to an organization via on-demand GitHub membership check.
 * Uses stored GitHub identity from membership records as fallback when WorkOS
 * doesn't have GitHub linked (e.g., user logged in via email/password).
 */
export const verifyOrgAccess = async (
  db: NodePgDatabase<typeof schema>,
  userId: string,
  org: OrgForVerification,
  env: Env
): Promise<OrgAccessResult> => {
  // Only GitHub orgs supported
  if (org.provider !== "github" || !org.providerInstallationId) {
    return { allowed: false, error: "GitHub App not installed" };
  }

  // Check for existing membership with stored GitHub identity (active members only)
  const existingMember = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.organizationId, org.id),
      isNull(organizationMembers.removedAt)
    ),
  });

  // Try WorkOS for GitHub identity first
  let githubIdentity: GitHubIdentity | null = await getVerifiedGitHubIdentity(
    userId,
    env.WORKOS_API_KEY
  );

  // Fall back to stored identity from membership record
  // Require both providerUserId and providerUsername to avoid empty username in API calls
  if (
    !githubIdentity &&
    existingMember?.providerUserId &&
    existingMember.providerUsername
  ) {
    githubIdentity = {
      userId: existingMember.providerUserId,
      username: existingMember.providerUsername,
    };
  }

  if (!githubIdentity) {
    return { allowed: false, error: "GitHub account not linked" };
  }

  // For personal accounts, check if user is the owner
  if (org.providerAccountType === "user") {
    if (githubIdentity.userId === org.providerAccountId) {
      return { allowed: true, role: "owner" };
    }
    return { allowed: false, error: "Not the owner of this account" };
  }

  // For organizations: if existing member with stored identity, trust the role
  // (GitHub membership was verified when they were added)
  // NOTE: This skips re-verification for performance. Users removed from GitHub
  // org retain Detent access until their membership record is removed (via org
  // admin or periodic cleanup). The middleware version (github-org-access.ts)
  // does re-verify on every request for stricter security.
  if (existingMember?.providerUserId) {
    return { allowed: true, role: existingMember.role };
  }

  // New access: verify GitHub org membership
  const membership = await verifyGitHubMembership(
    githubIdentity.username,
    org.providerAccountLogin,
    org.providerInstallationId,
    env
  );

  // App lacks members:read permission - can't auto-join
  if (membership.permissionDenied) {
    return {
      allowed: false,
      error:
        "Cannot verify GitHub membership automatically. Please ask an organization admin to invite you.",
    };
  }

  if (!membership.isMember) {
    return {
      allowed: false,
      error: "Not a member of this GitHub organization",
    };
  }

  // Determine role for new member
  let role: "owner" | "admin" | "member" = "member";
  if (org.installerGithubId === githubIdentity.userId) {
    role = "owner";
  } else if (membership.role === "admin") {
    role = "admin";
  }

  return { allowed: true, role };
};
