/**
 * Auth routes
 *
 * Handles identity synchronization from WorkOS to update organization members
 * with GitHub identity information obtained during authentication.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { organizationMembers, organizations } from "../db/schema";
import { verifyGitHubMembership } from "../lib/github-membership";
import type { Env } from "../types/env";

// GitHub API types
interface GitHubOrg {
  id: number;
  login: string;
  avatar_url: string;
}

interface GitHubOrgMembership {
  role: "admin" | "member";
  state: "active" | "pending";
}

// Response type for github-orgs endpoint
interface GitHubOrgWithStatus {
  id: number;
  login: string;
  avatar_url: string;
  can_install: boolean;
  already_installed: boolean;
  detent_org_id?: string;
}

// WorkOS identity from /user_management/users/:id/identities
interface WorkOSIdentity {
  idp_id: string;
  type: "OAuth";
  provider: string;
}

// Response from WorkOS identities endpoint
interface WorkOSIdentitiesResponse {
  data: WorkOSIdentity[];
}

// Response from WorkOS get user endpoint
interface WorkOSUser {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  profile_picture_url?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Regex for validating numeric target_id parameter
const NUMERIC_REGEX = /^\d+$/;

/**
 * Fetch GitHub username via WorkOS Pipes (authenticated)
 * Uses the user's OAuth token to avoid GitHub API rate limits (5000/hr vs 60/hr)
 */
const fetchGitHubUsername = async (
  userId: string,
  workosApiKey: string
): Promise<string | null> => {
  try {
    const tokenResponse = await fetch(
      "https://api.workos.com/data-integrations/github/token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workosApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId }),
      }
    );

    if (!tokenResponse.ok) {
      return null;
    }

    const tokenData = (await tokenResponse.json()) as {
      active: boolean;
      access_token?: { token: string };
    };

    if (!(tokenData.active && tokenData.access_token)) {
      return null;
    }

    const githubResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Detent-API",
      },
    });

    if (!githubResponse.ok) {
      return null;
    }

    const githubUser = (await githubResponse.json()) as { login: string };
    return githubUser.login;
  } catch {
    return null;
  }
};

/**
 * POST /sync-identity
 * Sync GitHub identity from WorkOS to all organization memberships for the authenticated user.
 * This is called after successful device code authentication to capture GitHub identity
 * if the user authenticated via GitHub OAuth through WorkOS.
 */
app.post("/sync-identity", async (c) => {
  const auth = c.get("auth");

  // Fetch user details and identities from WorkOS in parallel
  const [userResponse, identitiesResponse] = await Promise.all([
    fetch(`https://api.workos.com/user_management/users/${auth.userId}`, {
      headers: {
        Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
      },
    }),
    fetch(
      `https://api.workos.com/user_management/users/${auth.userId}/identities`,
      {
        headers: {
          Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
        },
      }
    ),
  ]);

  if (!userResponse.ok) {
    console.error(
      `Failed to fetch user from WorkOS: ${userResponse.status} ${userResponse.statusText}`
    );
    return c.json({ error: "Failed to fetch user details" }, 500);
  }

  const user = (await userResponse.json()) as WorkOSUser;

  if (!identitiesResponse.ok) {
    console.error(
      `Failed to fetch identities from WorkOS: ${identitiesResponse.status} ${identitiesResponse.statusText}`
    );
    // Return user info without GitHub identity - this is not a fatal error
    return c.json({
      user_id: auth.userId,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      github_synced: false,
      github_username: null,
    });
  }

  const identities =
    (await identitiesResponse.json()) as WorkOSIdentitiesResponse;

  // Find GitHub OAuth identity (with null check for malformed responses)
  const githubIdentity = identities.data?.find(
    (identity) => identity.provider === "GitHubOAuth"
  );

  if (!githubIdentity) {
    // No GitHub identity linked - return user info without GitHub
    return c.json({
      user_id: auth.userId,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      github_synced: false,
      github_username: null,
    });
  }

  // We have the GitHub idp_id (numeric GitHub user ID)
  const githubUserId = githubIdentity.idp_id;
  const githubUsername = await fetchGitHubUsername(
    auth.userId,
    c.env.WORKOS_API_KEY
  );

  // Update all organization memberships for this user with GitHub identity
  const { db, client } = await createDb(c.env);
  try {
    const updatedMembers = await db
      .update(organizationMembers)
      .set({
        providerUserId: githubUserId,
        providerUsername: githubUsername,
        providerLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(organizationMembers.userId, auth.userId))
      .returning({
        organizationId: organizationMembers.organizationId,
        providerUsername: organizationMembers.providerUsername,
      });

    // Auto-link organizations where this user is the installer but has no membership
    const installerOrgs = await db.query.organizations.findMany({
      where: and(
        eq(organizations.installerGithubId, githubUserId),
        isNull(organizations.deletedAt)
      ),
    });

    // Batch fetch existing memberships for all installer orgs
    const orgIds = installerOrgs.map((org) => org.id);
    const existingMemberships =
      orgIds.length > 0
        ? await db.query.organizationMembers.findMany({
            where: and(
              eq(organizationMembers.userId, auth.userId),
              inArray(organizationMembers.organizationId, orgIds)
            ),
          })
        : [];

    const existingOrgIds = new Set(
      existingMemberships.map((m) => m.organizationId)
    );

    // Filter to orgs that need new memberships
    const orgsToLink = installerOrgs.filter(
      (org) => !existingOrgIds.has(org.id)
    );

    // Verify current GitHub membership before granting owner access
    const verifiedOrgs: typeof orgsToLink = [];
    if (githubUsername) {
      for (const org of orgsToLink) {
        if (!(org.providerInstallationId && org.providerAccountLogin)) {
          continue;
        }
        const membership = await verifyGitHubMembership(
          githubUsername,
          org.providerAccountLogin,
          org.providerInstallationId,
          c.env
        );
        if (membership.isMember) {
          verifiedOrgs.push(org);
        }
      }
    }

    // Batch insert (if any)
    if (verifiedOrgs.length > 0) {
      await db.insert(organizationMembers).values(
        verifiedOrgs.map((org) => ({
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: auth.userId,
          role: "owner" as const,
          providerUserId: githubUserId,
          providerUsername: githubUsername,
          providerLinkedAt: new Date(),
        }))
      );
    }

    const autoLinkedCount = verifiedOrgs.length;

    return c.json({
      user_id: auth.userId,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      github_synced: true,
      github_user_id: githubUserId,
      github_username: githubUsername,
      organizations_updated: updatedMembers.length,
      installer_orgs_linked: autoLinkedCount,
    });
  } finally {
    await client.end();
  }
});

/**
 * GET /me
 * Get the current user's identity information including GitHub link status
 */
app.get("/me", async (c) => {
  const auth = c.get("auth");

  // Fetch user details from WorkOS and check DB membership in parallel
  const { db, client } = await createDb(c.env);
  try {
    const [userResponse, membership] = await Promise.all([
      fetch(`https://api.workos.com/user_management/users/${auth.userId}`, {
        headers: {
          Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
        },
      }),
      db.query.organizationMembers.findFirst({
        where: eq(organizationMembers.userId, auth.userId),
      }),
    ]);

    if (!userResponse.ok) {
      console.error(
        `Failed to fetch user from WorkOS: ${userResponse.status} ${userResponse.statusText}`
      );
      return c.json({ error: "Failed to fetch user details" }, 500);
    }

    const user = (await userResponse.json()) as WorkOSUser;

    // If no organization membership found, also check WorkOS identities directly
    // This handles the case where a user authenticated via GitHub but has no organization yet
    let githubUserId: string | null = membership?.providerUserId ?? null;
    const githubUsername: string | null = membership?.providerUsername ?? null;
    let githubLinked = Boolean(githubUserId);

    if (!githubLinked) {
      // Check WorkOS identities for GitHub OAuth
      const identitiesResponse = await fetch(
        `https://api.workos.com/user_management/users/${auth.userId}/identities`,
        {
          headers: {
            Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
          },
        }
      );

      if (identitiesResponse.ok) {
        const identities =
          (await identitiesResponse.json()) as WorkOSIdentitiesResponse;
        const githubIdentity = identities.data?.find(
          (identity) => identity.provider === "GitHubOAuth"
        );

        if (githubIdentity) {
          githubUserId = githubIdentity.idp_id;
          githubLinked = true;
          // Note: username not available from WorkOS identity, would need GitHub API call
        }
      }
    }

    return c.json({
      user_id: auth.userId,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      github_linked: githubLinked,
      github_user_id: githubUserId,
      github_username: githubUsername,
    });
  } finally {
    await client.end();
  }
});

// GitHub OAuth token format validation
// Accepts: classic PATs (ghp_), fine-grained PATs (github_pat_), and OAuth tokens (ghu_, gho_)
const GITHUB_TOKEN_REGEX = /^(ghp_|gho_|ghu_|github_pat_)[a-zA-Z0-9_]+$/;

// GitHub refresh token format validation (ghr_ prefix for GitHub App refresh tokens)
const GITHUB_REFRESH_TOKEN_REGEX = /^ghr_[a-zA-Z0-9_]+$/;

/**
 * Validate GitHub token format to prevent injection and ensure basic validity
 * Returns true if token matches known GitHub token patterns
 */
const isValidGitHubTokenFormat = (token: string): boolean => {
  // Token should be reasonable length
  // Classic PATs (ghp_) are 40 chars, fine-grained (github_pat_) are ~93 chars
  // OAuth tokens (ghu_, gho_) are similar to classic PATs
  if (token.length < 40 || token.length > 300) {
    return false;
  }
  // Must match known GitHub token prefixes
  return GITHUB_TOKEN_REGEX.test(token);
};

// Required GitHub OAuth scopes for organization operations
const REQUIRED_SCOPES = ["read:org"] as const;

// Result type for token verification with rate limit info and scope validation
interface VerifyTokenSuccessResult {
  success: true;
  user: { id: number; login: string };
  scopes: string[];
}

interface VerifyTokenFailureResult {
  success: false;
  rateLimited?: boolean;
  missingScopes?: string[];
}

type VerifyTokenResult = VerifyTokenSuccessResult | VerifyTokenFailureResult;

const parseOAuthScopes = (scopeHeader: string | null): string[] => {
  if (!scopeHeader) {
    return [];
  }
  return scopeHeader
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
};

const findMissingScopes = (
  actualScopes: string[],
  requiredScopes: readonly string[]
): string[] => {
  return requiredScopes.filter((required) => !actualScopes.includes(required));
};

/**
 * Verify a GitHub token belongs to the expected user by checking the authenticated user's GitHub ID
 * against the WorkOS identity. Also validates that the token has required scopes.
 * Returns the GitHub user data and scopes if verified, or failure info otherwise.
 */
const verifyGitHubTokenOwnership = async (
  githubToken: string,
  userId: string,
  workosApiKey: string
): Promise<VerifyTokenResult> => {
  const githubUserResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Detent-API",
    },
  });

  if (
    githubUserResponse.status === 403 &&
    githubUserResponse.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const resetTime = githubUserResponse.headers.get("x-ratelimit-reset");
    const resetDate = resetTime
      ? new Date(Number.parseInt(resetTime, 10) * 1000).toISOString()
      : "soon";
    console.error(
      `GitHub API rate limit exceeded during token verification, resets at ${resetDate}`
    );
    return { success: false, rateLimited: true };
  }

  if (!githubUserResponse.ok) {
    return { success: false };
  }

  const scopes = parseOAuthScopes(
    githubUserResponse.headers.get("x-oauth-scopes")
  );

  const missingScopes = findMissingScopes(scopes, REQUIRED_SCOPES);
  if (missingScopes.length > 0) {
    console.error(
      `GitHub token missing required scopes: ${missingScopes.join(", ")}`
    );
    return { success: false, missingScopes };
  }

  let githubUser: { id: number; login: string };
  try {
    githubUser = (await githubUserResponse.json()) as {
      id: number;
      login: string;
    };
  } catch (error) {
    console.error(
      "Failed to parse GitHub user response as JSON",
      error instanceof Error ? error.message : error
    );
    return { success: false };
  }

  const identitiesResponse = await fetch(
    `https://api.workos.com/user_management/users/${userId}/identities`,
    {
      headers: {
        Authorization: `Bearer ${workosApiKey}`,
      },
    }
  );

  if (!identitiesResponse.ok) {
    return { success: false };
  }

  let identities: WorkOSIdentitiesResponse;
  try {
    identities = (await identitiesResponse.json()) as WorkOSIdentitiesResponse;
  } catch (error) {
    console.error(
      "Failed to parse WorkOS identities response as JSON",
      error instanceof Error ? error.message : error
    );
    return { success: false };
  }

  const githubIdentity = identities.data?.find(
    (identity) => identity.provider === "GitHubOAuth"
  );

  if (!githubIdentity) {
    return { success: false };
  }

  if (String(githubUser.id) !== githubIdentity.idp_id) {
    console.error("GitHub token ownership verification failed for user");
    return { success: false };
  }

  return { success: true, user: githubUser, scopes };
};

// Valid HTTP status codes for token and API error responses
type TokenErrorStatus = 400 | 401 | 403 | 429 | 500;

// Result types for token acquisition and error handling
interface TokenErrorResult {
  error: string;
  code?: string;
  status: TokenErrorStatus;
}

type TokenResult =
  | { success: true; token: string }
  | ({ success: false } & TokenErrorResult);

/**
 * Get a verified GitHub token from the X-GitHub-Token header
 * Validates format, verifies token ownership, and checks required scopes
 */
const getVerifiedGitHubToken = async (
  providedToken: string | undefined,
  userId: string,
  workosApiKey: string
): Promise<TokenResult> => {
  if (!providedToken) {
    return {
      success: false,
      error:
        "GitHub token required. Please re-authenticate with `dt auth login --force`.",
      code: "github_token_required",
      status: 401,
    };
  }

  if (!isValidGitHubTokenFormat(providedToken)) {
    return {
      success: false,
      error: "Invalid GitHub token format",
      code: "invalid_token_format",
      status: 400,
    };
  }

  const verifyResult = await verifyGitHubTokenOwnership(
    providedToken,
    userId,
    workosApiKey
  );

  if (!verifyResult.success) {
    if (verifyResult.rateLimited) {
      return {
        success: false,
        error: "GitHub API rate limit exceeded. Please try again later.",
        code: "rate_limit_exceeded",
        status: 429,
      };
    }
    if (verifyResult.missingScopes && verifyResult.missingScopes.length > 0) {
      return {
        success: false,
        error: `GitHub token is missing required scopes: ${verifyResult.missingScopes.join(", ")}. Please re-authenticate with \`dt auth login --force\` to grant the necessary permissions.`,
        code: "missing_scopes",
        status: 401,
      };
    }
    return {
      success: false,
      error:
        "GitHub token verification failed. Please re-authenticate with `dt auth login --force`.",
      code: "token_verification_failed",
      status: 401,
    };
  }

  return { success: true, token: providedToken };
};

/**
 * Handle GitHub API response errors with appropriate user-facing messages
 */
const handleGitHubApiError = (response: Response): TokenErrorResult => {
  const status = response.status;

  // Rate limit exceeded (403 with x-ratelimit-remaining: 0)
  if (status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const resetTime = response.headers.get("x-ratelimit-reset");
    const resetDate = resetTime
      ? new Date(Number.parseInt(resetTime, 10) * 1000).toISOString()
      : "soon";
    console.error(`GitHub API rate limit exceeded, resets at ${resetDate}`);
    return {
      error: "GitHub API rate limit exceeded. Please try again later.",
      code: "rate_limit_exceeded",
      status: 429,
    };
  }

  // Permission denied (403 without rate limit indicator)
  if (status === 403) {
    console.error("GitHub API returned 403 - insufficient permissions");
    return {
      error:
        "GitHub access denied - insufficient permissions. Please re-authenticate with `dt auth login --force`.",
      code: "github_permission_denied",
      status: 403,
    };
  }

  // Unauthorized - token invalid or expired
  if (status === 401) {
    console.error("GitHub API returned 401 - token invalid or expired");
    return {
      error:
        "GitHub authentication failed. Please re-authenticate with `dt auth login --force`.",
      code: "github_auth_failed",
      status: 401,
    };
  }

  // Generic error - don't expose GitHub API details to client
  console.error(`GitHub API error: ${status} ${response.statusText}`);
  return {
    error: "Failed to fetch GitHub organizations",
    status: 500,
  };
};

/**
 * GET /github-orgs
 * List GitHub organizations where the authenticated user can install the Detent GitHub App.
 * Returns org details with installation status and user's admin capability.
 *
 * Requires GitHub OAuth token via X-GitHub-Token header.
 * The token is validated for format and verified to belong to the authenticated user.
 */
app.get("/github-orgs", async (c) => {
  const auth = c.get("auth");

  // Get verified GitHub token from header
  const tokenResult = await getVerifiedGitHubToken(
    c.req.header("X-GitHub-Token"),
    auth.userId,
    c.env.WORKOS_API_KEY
  );

  if (!tokenResult.success) {
    return c.json(
      {
        error: tokenResult.error,
        ...(tokenResult.code && { code: tokenResult.code }),
      },
      tokenResult.status
    );
  }

  const githubToken = tokenResult.token;

  // Fetch user's GitHub organizations
  const orgsResponse = await fetch("https://api.github.com/user/orgs", {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Detent-API",
    },
  });

  if (!orgsResponse.ok) {
    const errorResult = handleGitHubApiError(orgsResponse);
    return c.json(
      {
        error: errorResult.error,
        ...(errorResult.code && { code: errorResult.code }),
      },
      errorResult.status
    );
  }

  const githubOrgs = (await orgsResponse.json()) as GitHubOrg[];

  if (githubOrgs.length === 0) {
    return c.json({ orgs: [] });
  }

  // Fetch membership details for each org in parallel to check admin status
  const membershipPromises = githubOrgs.map((org) =>
    fetch(`https://api.github.com/user/memberships/orgs/${org.login}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Detent-API",
      },
    }).then(async (res) => {
      if (!res.ok) {
        return { org: org.login, membership: null };
      }
      const membership = (await res.json()) as GitHubOrgMembership;
      return { org: org.login, membership };
    })
  );

  const memberships = await Promise.all(membershipPromises);
  const membershipMap = new Map(memberships.map((m) => [m.org, m.membership]));

  // Query our database to find which orgs are already installed
  const { db, client } = await createDb(c.env);
  try {
    const githubOrgIds = githubOrgs.map((org) => String(org.id));
    const installedOrgs = await db.query.organizations.findMany({
      where: (orgs, { and, eq, inArray, isNull }) =>
        and(
          eq(orgs.provider, "github"),
          inArray(orgs.providerAccountId, githubOrgIds),
          isNull(orgs.deletedAt)
        ),
    });

    const installedOrgMap = new Map(
      installedOrgs.map((org) => [org.providerAccountId, org])
    );

    // Build response
    const orgsWithStatus: GitHubOrgWithStatus[] = githubOrgs.map((org) => {
      const membership = membershipMap.get(org.login);
      const installedOrg = installedOrgMap.get(String(org.id));

      return {
        id: org.id,
        login: org.login,
        avatar_url: org.avatar_url,
        can_install:
          membership?.role === "admin" && membership?.state === "active",
        already_installed: Boolean(installedOrg),
        ...(installedOrg && { detent_org_id: installedOrg.id }),
      };
    });

    return c.json({ orgs: orgsWithStatus });
  } finally {
    await client.end();
  }
});

// GitHub token refresh response
interface GitHubTokenRefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
  token_type: string;
}

// GitHub token refresh error response
interface GitHubTokenRefreshError {
  error: string;
  error_description?: string;
}

/**
 * POST /github-token/refresh
 * Refresh a GitHub OAuth token using the refresh token.
 * This endpoint keeps the GitHub App client secret server-side.
 *
 * GitHub user access tokens expire after 8 hours, refresh tokens after 6 months.
 * When the access token expires, the CLI calls this endpoint to get a new one.
 */
app.post("/github-token/refresh", async (c) => {
  const auth = c.get("auth");

  // Validate GITHUB_CLIENT_SECRET is configured
  if (!c.env.GITHUB_CLIENT_SECRET) {
    console.error(
      "GITHUB_CLIENT_SECRET not configured - GitHub token refresh unavailable"
    );
    return c.json(
      {
        error: "GitHub token refresh not configured on server",
        code: "refresh_not_configured",
      },
      501
    );
  }

  // Parse request body
  let body: { refresh_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }

  const { refresh_token: refreshToken } = body;

  if (!refreshToken) {
    return c.json(
      { error: "refresh_token is required", code: "missing_refresh_token" },
      400
    );
  }

  // Validate refresh token format including character set (consistent with access token validation)
  if (
    !GITHUB_REFRESH_TOKEN_REGEX.test(refreshToken) ||
    refreshToken.length < 20 ||
    refreshToken.length > 300
  ) {
    return c.json(
      { error: "Invalid refresh token format", code: "invalid_token_format" },
      400
    );
  }

  // Call GitHub's token endpoint to refresh
  const githubResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }
  );

  if (!githubResponse.ok) {
    console.error(
      `GitHub token refresh failed: ${githubResponse.status} ${githubResponse.statusText}`
    );
    return c.json(
      {
        error: "Failed to refresh GitHub token",
        code: "github_refresh_failed",
      },
      502
    );
  }

  let tokenData: GitHubTokenRefreshResponse | GitHubTokenRefreshError;
  try {
    tokenData = await githubResponse.json();
  } catch {
    console.error("Failed to parse GitHub token refresh response");
    return c.json(
      { error: "Invalid response from GitHub", code: "invalid_response" },
      502
    );
  }

  // Check for error response from GitHub
  if ("error" in tokenData) {
    const errorData = tokenData as GitHubTokenRefreshError;
    console.error(
      `GitHub token refresh error: ${errorData.error} - ${errorData.error_description}`
    );

    // Map common GitHub errors to user-friendly messages
    if (errorData.error === "bad_refresh_token") {
      return c.json(
        {
          error:
            "GitHub refresh token is invalid or expired. Please re-authenticate with `dt auth login --force`.",
          code: "refresh_token_expired",
        },
        401
      );
    }

    return c.json(
      {
        error: "GitHub token refresh failed. Please re-authenticate.",
        code: "github_refresh_failed",
      },
      401
    );
  }

  const successData = tokenData as GitHubTokenRefreshResponse;

  // Verify the new token belongs to the authenticated user
  const verifyResult = await verifyGitHubTokenOwnership(
    successData.access_token,
    auth.userId,
    c.env.WORKOS_API_KEY
  );

  if (!verifyResult.success) {
    console.error("Refreshed GitHub token ownership verification failed");
    return c.json(
      {
        error: "Token ownership verification failed",
        code: "ownership_verification_failed",
      },
      401
    );
  }

  // Log successful token refresh for security auditing
  console.log(`[audit] GitHub token refreshed for user ${auth.userId}`);

  // Return new tokens with expiry timestamps
  const now = Date.now();
  return c.json({
    access_token: successData.access_token,
    access_token_expires_at: now + successData.expires_in * 1000,
    refresh_token: successData.refresh_token,
    refresh_token_expires_at: now + successData.refresh_token_expires_in * 1000,
  });
});

/**
 * GET /install-url
 * Generate a GitHub App installation URL with a pre-selected target organization
 */
app.get("/install-url", (c) => {
  const targetId = c.req.query("target_id");

  if (!targetId) {
    return c.json({ error: "target_id query parameter is required" }, 400);
  }

  if (!NUMERIC_REGEX.test(targetId)) {
    return c.json({ error: "target_id must be a numeric value" }, 400);
  }

  const appName = "detent";
  const url = `https://github.com/apps/${appName}/installations/new?target_id=${targetId}`;

  return c.json({ url });
});

/**
 * GET /organizations
 * List organizations the user is a member of
 */
app.get("/organizations", async (c) => {
  const auth = c.get("auth");

  const { db, client } = await createDb(c.env);
  try {
    const memberships = await db.query.organizationMembers.findMany({
      where: eq(organizationMembers.userId, auth.userId),
      with: { organization: true },
    });

    return c.json({
      organizations: memberships.map((m) => ({
        organization_id: m.organizationId,
        organization_name: m.organization.name,
        organization_slug: m.organization.slug,
        github_org: m.organization.providerAccountLogin,
        role: m.role,
        github_linked: Boolean(m.providerUserId),
        github_username: m.providerUsername,
      })),
    });
  } finally {
    await client.end();
  }
});

export default app;
