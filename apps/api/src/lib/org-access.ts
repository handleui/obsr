/**
 * Organization access verification utilities
 *
 * Verifies user access to organizations via real-time GitHub membership checks.
 * Used across multiple routes to ensure consistent access control.
 */

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
  role?: "owner" | "admin" | "member";
  error?: string;
}

/**
 * Verify user has access to an organization via on-demand GitHub membership check.
 * This replaces stale database lookups with real-time verification.
 */
export const verifyOrgAccess = async (
  userId: string,
  org: OrgForVerification,
  env: Env
): Promise<OrgAccessResult> => {
  // Only GitHub orgs supported
  if (org.provider !== "github" || !org.providerInstallationId) {
    return { allowed: false, error: "GitHub App not installed" };
  }

  // Get verified GitHub identity
  const githubIdentity = await getVerifiedGitHubIdentity(
    userId,
    env.WORKOS_API_KEY
  );
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

  // Verify GitHub org membership
  const membership = await verifyGitHubMembership(
    githubIdentity.username,
    org.providerAccountLogin,
    org.providerInstallationId,
    env
  );

  if (!membership.isMember) {
    return {
      allowed: false,
      error: "Not a member of this GitHub organization",
    };
  }

  // Determine role
  let role: "owner" | "admin" | "member" = "member";
  if (org.installerGithubId === githubIdentity.userId) {
    role = "owner";
  } else if (membership.role === "admin") {
    role = "admin";
  }

  return { allowed: true, role };
};
