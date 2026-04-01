/**
 * Auth routes
 *
 * Handles identity synchronization from Better Auth account linkage to update
 * organization members with GitHub identity information obtained during
 * authentication.
 */

import { Hono } from "hono";
import type { ObserverClient } from "../db/client";
import { getDbClient } from "../db/client";
import { getBetterAuthPool } from "../lib/better-auth";
import { verifyGitHubMembership } from "../lib/github-membership";
import type { Env } from "../types/env";

// Regex for parsing GitHub Link header pagination
const GITHUB_LINK_NEXT_REGEX = /<([^>]+)>;\s*rel="next"/;

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

interface BetterAuthUser {
  id: string;
  email: string;
  name: string | null;
}

interface BetterAuthGitHubAccount {
  accountId: string;
  accessToken: string | null;
}

interface OrganizationDoc {
  _id: string;
  name: string;
  slug: string;
  provider: "github" | "gitlab";
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerInstallationId?: string;
  installerGithubId?: string;
  deletedAt?: number;
  settings?: Record<string, unknown> | null;
}

interface OrganizationMemberDoc {
  _id: string;
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "visitor";
  providerUserId?: string;
  providerUsername?: string;
  removedAt?: number | null;
  removalReason?: string | null;
}

const app = new Hono<{ Bindings: Env }>();

// Regex for validating numeric target_id parameter
const NUMERIC_REGEX = /^\d+$/;
const WHITESPACE_SPLIT_REGEX = /\s+/;
const NUMERIC_ACCOUNT_ID_PATTERN = /^\d+$/;
const GITHUB_PROVIDER_ID = "github";
const GITHUB_MEMBERSHIP_CONCURRENCY = 8;
const GITHUB_MEMBERSHIP_TIMEOUT_MS = 8000;
const GITHUB_MEMBERSHIP_MAX_ATTEMPTS = 2;
const GITHUB_MEMBERSHIP_RETRY_DELAY_MS = 500;

const splitDisplayName = (
  name: string | null
): { firstName?: string; lastName?: string } => {
  if (!name) {
    return {};
  }

  const parts = name.trim().split(WHITESPACE_SPLIT_REGEX).filter(Boolean);
  if (parts.length === 0) {
    return {};
  }

  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface GitHubIdentity {
  userId: string;
  username: string | null;
}

interface GitHubUserResponse {
  id: number;
  login: string;
}

interface GitHubMembershipLookupResult {
  org: string;
  membership: GitHubOrgMembership | null;
  hardFailureStatus?: number;
  rateLimited?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitedResponse = (response: Response): boolean =>
  response.status === 429 ||
  (response.status === 403 &&
    response.headers.get("x-ratelimit-remaining") === "0");

const isHardFailureStatus = (status: number): boolean =>
  status === 401 || status === 403 || status === 429 || status >= 500;

const shouldRetryMembershipLookup = (
  response: Response,
  attempt: number
): boolean =>
  attempt + 1 < GITHUB_MEMBERSHIP_MAX_ATTEMPTS &&
  (isRateLimitedResponse(response) || response.status >= 500);

const parseGitHubOrgMembership = (
  payload: Partial<GitHubOrgMembership>
): GitHubOrgMembership | null => {
  if (
    (payload.role === "admin" || payload.role === "member") &&
    (payload.state === "active" || payload.state === "pending")
  ) {
    return {
      role: payload.role,
      state: payload.state,
    };
  }

  return null;
};

const fetchGitHubOrgMembership = async (
  orgLogin: string,
  githubToken: string
): Promise<GitHubMembershipLookupResult> => {
  for (let attempt = 0; attempt < GITHUB_MEMBERSHIP_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${orgLogin}`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Detent-API",
          },
          signal: AbortSignal.timeout(GITHUB_MEMBERSHIP_TIMEOUT_MS),
        }
      );

      if (response.ok) {
        const payload = (await response.json()) as Partial<GitHubOrgMembership>;
        const membership = parseGitHubOrgMembership(payload);
        if (membership) {
          return {
            org: orgLogin,
            membership,
          };
        }
        return { org: orgLogin, membership: null };
      }

      if (response.status === 404) {
        return { org: orgLogin, membership: null };
      }

      const rateLimited = isRateLimitedResponse(response);

      if (
        isHardFailureStatus(response.status) &&
        shouldRetryMembershipLookup(response, attempt)
      ) {
        await sleep(GITHUB_MEMBERSHIP_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }

      if (isHardFailureStatus(response.status)) {
        return {
          org: orgLogin,
          membership: null,
          hardFailureStatus: response.status,
          rateLimited,
        };
      }

      return { org: orgLogin, membership: null };
    } catch {
      if (attempt + 1 < GITHUB_MEMBERSHIP_MAX_ATTEMPTS) {
        await sleep(GITHUB_MEMBERSHIP_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return { org: orgLogin, membership: null, hardFailureStatus: 502 };
    }
  }

  return { org: orgLogin, membership: null, hardFailureStatus: 502 };
};

const mapWithConcurrency = async <TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> => {
  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let index = 0;

  const workers = Array.from({ length: cappedConcurrency }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index++;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await mapper(item);
    }
  });

  await Promise.all(workers);
  return results;
};

const loadBetterAuthUser = async (
  userId: string,
  env: Env
): Promise<BetterAuthUser | null> => {
  const pool = getBetterAuthPool(env);
  const result = await pool.query<{
    id: string;
    email: string;
    name: string | null;
  }>(
    `
      SELECT id, email, name
      FROM "user"
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
  };
};

const loadLatestGitHubAccount = async (
  userId: string,
  env: Env
): Promise<BetterAuthGitHubAccount | null> => {
  const pool = getBetterAuthPool(env);
  const result = await pool.query<{
    account_id: string;
    access_token: string | null;
  }>(
    `
      SELECT account_id, access_token
      FROM account
      WHERE user_id = $1 AND provider_id = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [userId, GITHUB_PROVIDER_ID]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    accountId: row.account_id,
    accessToken: row.access_token,
  };
};

const fetchGitHubUserByAccountId = async (
  accountId: string
): Promise<GitHubUserResponse | null> => {
  const urls = NUMERIC_ACCOUNT_ID_PATTERN.test(accountId)
    ? [
        `https://api.github.com/user/${accountId}`,
        `https://api.github.com/users/${accountId}`,
      ]
    : [`https://api.github.com/users/${accountId}`];

  for (const url of urls) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Detent-API",
      },
    });

    if (!response.ok) {
      continue;
    }

    const payload = await response.json();
    if (
      isRecord(payload) &&
      typeof payload.id === "number" &&
      typeof payload.login === "string"
    ) {
      return {
        id: payload.id,
        login: payload.login,
      };
    }
  }

  return null;
};

/**
 * Get GitHub identity from a provided OAuth token
 */
const getGitHubIdentityFromToken = async (
  token: string,
  context = "github-identity"
): Promise<GitHubIdentity | null> => {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Detent-API",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.warn(
      `[${context}] GitHub token provided but API call failed: ${response.status} - ${errorBody}`
    );
    return null;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    console.warn(`[${context}] Failed to parse GitHub user response`);
    return null;
  }

  if (!isRecord(data)) {
    console.warn(`[${context}] Invalid GitHub user response`);
    return null;
  }

  const githubUserId = typeof data.id === "number" ? String(data.id) : null;
  const githubUsername = typeof data.login === "string" ? data.login : null;

  if (!githubUserId) {
    console.warn(`[${context}] GitHub user response missing id`);
    return null;
  }

  return {
    userId: githubUserId,
    username: githubUsername,
  };
};

const getGitHubIdentityFromLinkedAccount = async (
  accountId: string
): Promise<GitHubIdentity | null> => {
  const githubUser = await fetchGitHubUserByAccountId(accountId);
  if (!githubUser) {
    return {
      userId: accountId,
      username: null,
    };
  }

  return {
    userId: String(githubUser.id),
    username: githubUser.login,
  };
};

/**
 * Link user to organizations where they are the installer
 * Verifies current GitHub org membership before granting owner access
 */
const linkInstallerOrganizations = async (
  dbClient: ObserverClient,
  userId: string,
  githubUserId: string,
  githubUsername: string | null,
  env: Env
): Promise<number> => {
  // Cannot verify membership without username
  if (!githubUsername) {
    return 0;
  }

  const installerOrgs = (await dbClient.query(
    "organizations:listByInstallerGithubId",
    {
      installerGithubId: githubUserId,
    }
  )) as OrganizationDoc[];
  const activeInstallerOrgs = installerOrgs.filter((org) => !org.deletedAt);

  if (activeInstallerOrgs.length === 0) {
    return 0;
  }

  const orgIds = activeInstallerOrgs.map((org) => org._id);

  // Get active memberships only - soft-deleted users must go through invitation flow
  const activeMemberships = (
    (await dbClient.query("organization_members:listByUser", {
      userId,
      limit: 500,
    })) as OrganizationMemberDoc[]
  ).filter(
    (membership) =>
      orgIds.includes(membership.organizationId) && !membership.removedAt
  );

  const activeMemberOrgIds = new Set(
    activeMemberships.map((m) => m.organizationId)
  );

  // Filter to orgs that need linking (no active membership)
  const orgsToLink = activeInstallerOrgs.filter(
    (org) => !activeMemberOrgIds.has(org._id)
  );

  // Verify current GitHub membership before granting owner access
  // This prevents users who have left the org from claiming access
  const verificationPromises = orgsToLink.map(async (org) => {
    if (!(org.providerInstallationId && org.providerAccountLogin)) {
      return null;
    }

    // Personal accounts: verify by matching GitHub user ID (no membership API)
    if (org.providerAccountType === "user") {
      return githubUserId === org.providerAccountId ? org : null;
    }

    // Organizations: verify via GitHub membership API
    try {
      const membership = await verifyGitHubMembership(
        githubUsername,
        org.providerAccountLogin,
        org.providerInstallationId,
        env
      );
      return membership.isMember ? org : null;
    } catch (error) {
      // Log but continue - don't fail entire operation if one org check fails
      console.warn(
        `[sync-user] Failed to verify membership for ${githubUsername} in ${org.providerAccountLogin}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  });

  const verificationResults = await Promise.all(verificationPromises);
  const isVerifiedOrg = (
    org: (typeof orgsToLink)[number] | null
  ): org is (typeof orgsToLink)[number] => org !== null;
  const verifiedOrgs = verificationResults.filter(isVerifiedOrg);

  let linked = 0;

  for (const org of verifiedOrgs) {
    const existing = (await dbClient.query(
      "organization_members:getByOrgUser",
      {
        organizationId: org._id,
        userId,
      }
    )) as OrganizationMemberDoc | null;

    if (existing) {
      continue;
    }

    const now = Date.now();
    await dbClient.mutation("organization_members:create", {
      organizationId: org._id,
      userId,
      role: "owner",
      providerUserId: githubUserId,
      providerUsername: githubUsername,
      providerLinkedAt: now,
      providerVerifiedAt: now,
      membershipSource: "installer",
      createdAt: now,
      updatedAt: now,
    });

    console.log(
      `[sync-user] Auto-linked installer ${githubUsername} as owner to ${org.slug}`
    );
    linked++;
  }

  return linked;
};

/**
 * Fetch all GitHub orgs for a user, handling pagination.
 * GitHub paginates at 100 results per page.
 */
const fetchAllGitHubOrgs = async (
  githubToken: string
): Promise<{ id: number; login: string }[] | null> => {
  const allOrgs: { id: number; login: string }[] = [];
  let url: string | null = "https://api.github.com/user/orgs?per_page=100";

  while (url) {
    const response: Response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Detent-API",
      },
    });

    if (!response.ok) {
      console.warn(
        `[sync-user] Failed to fetch GitHub orgs page: ${response.status}, fetched ${allOrgs.length} so far`
      );
      return allOrgs.length > 0 ? allOrgs : null;
    }

    const orgs = (await response.json()) as { id: number; login: string }[];
    allOrgs.push(...orgs);

    // Parse Link header for next page
    const linkHeader: string | null = response.headers.get("link");
    const nextMatch: RegExpMatchArray | null | undefined = linkHeader?.match(
      GITHUB_LINK_NEXT_REGEX
    );
    url = nextMatch?.[1] ?? null;
  }

  return allOrgs;
};

// Type for soft-deleted membership info
interface SoftDeletedMembership {
  _id: string;
  removalReason: string | null;
  role: string;
}

/**
 * Fetch Detent orgs matching the user's GitHub orgs with mirroring enabled.
 * Returns orgs that don't have an active membership for the user.
 */
const fetchMatchingDetentOrgs = async (
  dbClient: ObserverClient,
  userId: string,
  githubOrgs: { id: number; login: string }[]
): Promise<{
  orgsToJoin: OrganizationDoc[];
  softDeletedByOrg: Map<string, SoftDeletedMembership>;
} | null> => {
  const githubOrgIds = githubOrgs.map((o) => String(o.id));
  const detentOrgs = (await dbClient.query(
    "organizations:listByProviderAccountIds",
    {
      provider: "github",
      providerAccountIds: githubOrgIds,
      includeDeleted: false,
    }
  )) as OrganizationDoc[];

  if (detentOrgs.length === 0) {
    return null;
  }

  const detentOrgIds = detentOrgs.map((o) => o._id);
  const allMemberships = (
    (await dbClient.query("organization_members:listByUser", {
      userId,
      limit: 500,
    })) as OrganizationMemberDoc[]
  ).filter((membership) => detentOrgIds.includes(membership.organizationId));

  // Build maps for different membership states
  const activeMemberOrgIds = new Set<string>();
  const softDeletedByOrg = new Map<string, SoftDeletedMembership>();

  for (const m of allMemberships) {
    if (m.removedAt) {
      softDeletedByOrg.set(m.organizationId, {
        _id: m._id,
        removalReason: m.removalReason ?? null,
        role: m.role,
      });
    } else {
      activeMemberOrgIds.add(m.organizationId);
    }
  }

  const orgsToJoin = detentOrgs.filter(
    (org) => !activeMemberOrgIds.has(org._id)
  );

  if (orgsToJoin.length === 0) {
    return null;
  }

  return { orgsToJoin, softDeletedByOrg };
};

/**
 * Handle an existing soft-deleted membership by reactivating it.
 * Returns true if membership was reactivated, false if blocked.
 */
const handleExistingMembership = async (
  dbClient: ObserverClient,
  softDeleted: SoftDeletedMembership,
  role: "admin" | "member",
  githubUserId: string,
  githubUsername: string,
  orgSlug: string | null
): Promise<boolean> => {
  if (softDeleted.removalReason === "admin_action") {
    console.log(
      `[sync-user] User ${githubUsername} blocked from auto-join to ${orgSlug} (admin removed)`
    );
    return false;
  }

  const now = Date.now();
  await dbClient.mutation("organization_members:update", {
    id: softDeleted._id,
    removedAt: null,
    removalReason: null,
    removedBy: null,
    role,
    providerUserId: githubUserId,
    providerUsername: githubUsername,
    providerLinkedAt: now,
    providerVerifiedAt: now,
    membershipSource: "github_sync",
    updatedAt: now,
  });

  console.log(
    `[sync-user] Reactivated ${githubUsername} to ${orgSlug} as ${role}`
  );
  return true;
};

/**
 * Create a new membership for a user in an organization.
 * Returns true if membership was created, false otherwise.
 */
const createNewMembership = async (
  dbClient: ObserverClient,
  orgId: string,
  userId: string,
  role: "admin" | "member",
  githubUserId: string,
  githubUsername: string,
  orgSlug: string | null
): Promise<boolean> => {
  const existing = (await dbClient.query("organization_members:getByOrgUser", {
    organizationId: orgId,
    userId,
  })) as OrganizationMemberDoc | null;

  if (existing) {
    return false;
  }

  const now = Date.now();
  await dbClient.mutation("organization_members:create", {
    organizationId: orgId,
    userId,
    role,
    providerUserId: githubUserId,
    providerUsername: githubUsername,
    providerLinkedAt: now,
    providerVerifiedAt: now,
    membershipSource: "github_sync",
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    `[sync-user] Auto-joined ${githubUsername} to ${orgSlug} as ${role}`
  );
  return true;
};

/**
 * Process a single org for membership linking.
 * Verifies GitHub membership and creates/reactivates Detent membership.
 * Returns true if a membership was created or reactivated.
 */
const processOrgMembership = async (
  dbClient: ObserverClient,
  org: OrganizationDoc,
  userId: string,
  githubUserId: string,
  githubUsername: string,
  softDeletedByOrg: Map<string, SoftDeletedMembership>,
  env: Env
): Promise<boolean> => {
  if (!(org.providerInstallationId && org.providerAccountLogin)) {
    return false;
  }

  const membership = await verifyGitHubMembership(
    githubUsername,
    org.providerAccountLogin,
    org.providerInstallationId,
    env
  );
  if (!membership.isMember) {
    return false;
  }

  const role = membership.role === "admin" ? "admin" : "member";
  const softDeleted = softDeletedByOrg.get(org._id);

  if (softDeleted) {
    return handleExistingMembership(
      dbClient,
      softDeleted,
      role,
      githubUserId,
      githubUsername,
      org.slug
    );
  }

  return createNewMembership(
    dbClient,
    org._id,
    userId,
    role,
    githubUserId,
    githubUsername,
    org.slug
  );
};

/**
 * Auto-join user to GitHub orgs where Detent is already installed.
 * This allows non-installer admins/members to join existing orgs.
 */
const linkGitHubMemberOrganizations = async (
  dbClient: ObserverClient,
  userId: string,
  githubUserId: string,
  githubUsername: string,
  githubToken: string,
  env: Env
): Promise<number> => {
  const githubOrgs = await fetchAllGitHubOrgs(githubToken);
  if (!githubOrgs || githubOrgs.length === 0) {
    return 0;
  }

  const matchResult = await fetchMatchingDetentOrgs(
    dbClient,
    userId,
    githubOrgs
  );
  if (!matchResult) {
    return 0;
  }

  const { orgsToJoin, softDeletedByOrg } = matchResult;
  let joined = 0;

  for (const org of orgsToJoin) {
    try {
      const success = await processOrgMembership(
        dbClient,
        org,
        userId,
        githubUserId,
        githubUsername,
        softDeletedByOrg,
        env
      );
      if (success) {
        joined++;
      }
    } catch (error) {
      console.warn(
        `[sync-user] Failed to verify/join ${githubUsername} to ${org.slug}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return joined;
};

/**
 * POST /sync-user
 * Sync GitHub identity and link user to organizations where they are the installer.
 *
 * Accepts optional X-GitHub-Token header with the user's GitHub OAuth token.
 * If provided, uses the token directly to get the user's GitHub ID (preferred).
 * Falls back to Better Auth account linkage if no token provided.
 */
app.post("/sync-user", async (c) => {
  const auth = c.get("auth");
  const providedGitHubToken = c.req.header("X-GitHub-Token");
  let verifiedGitHubToken: string | undefined;
  const [user, linkedGitHubAccount] = await Promise.all([
    loadBetterAuthUser(auth.userId, c.env),
    loadLatestGitHubAccount(auth.userId, c.env),
  ]);

  if (!user) {
    console.error(`Failed to load Better Auth user for ${auth.userId}`);
    return c.json({ error: "Failed to fetch user details" }, 500);
  }

  const { firstName, lastName } = splitDisplayName(user.name);

  // Security: never trust raw X-GitHub-Token without ownership verification.
  // If verification fails, continue with Better Auth account linkage fallback.
  if (providedGitHubToken) {
    const tokenResult = await getVerifiedOptionalGitHubToken(
      providedGitHubToken,
      linkedGitHubAccount?.accountId ?? null
    );

    if (tokenResult.success) {
      verifiedGitHubToken = tokenResult.token;
    } else {
      console.warn(
        `[sync-user] Ignoring unverified GitHub token for user ${auth.userId}: ${tokenResult.reason}`
      );
    }
  }

  let identity: GitHubIdentity | null = null;
  if (verifiedGitHubToken) {
    identity = await getGitHubIdentityFromToken(
      verifiedGitHubToken,
      "sync-user"
    );
  }

  if (!identity && linkedGitHubAccount) {
    identity = await getGitHubIdentityFromLinkedAccount(
      linkedGitHubAccount.accountId
    );
  }

  if (!identity) {
    return c.json({
      user_id: auth.userId,
      email: user.email,
      first_name: firstName,
      last_name: lastName,
      github_synced: false,
      github_username: null,
    });
  }

  const dbClient = getDbClient(c.env);

  const memberships = (await dbClient.query("organization_members:listByUser", {
    userId: auth.userId,
    limit: 500,
  })) as OrganizationMemberDoc[];

  const now = Date.now();
  await Promise.all(
    memberships.map((membership) =>
      dbClient.mutation("organization_members:update", {
        id: membership._id,
        providerUserId: identity.userId,
        providerUsername: identity.username ?? undefined,
        providerLinkedAt: now,
        updatedAt: now,
      })
    )
  );

  // Auto-link installer organizations (with membership verification)
  const autoLinkedCount = await linkInstallerOrganizations(
    dbClient,
    auth.userId,
    identity.userId,
    identity.username,
    c.env
  );

  // Auto-join GitHub orgs where app is already installed (non-installer path)
  let autoJoinedCount = 0;
  if (verifiedGitHubToken && identity.username) {
    autoJoinedCount = await linkGitHubMemberOrganizations(
      dbClient,
      auth.userId,
      identity.userId,
      identity.username,
      verifiedGitHubToken,
      c.env
    );
  }

  return c.json({
    user_id: auth.userId,
    email: user.email,
    first_name: firstName,
    last_name: lastName,
    github_synced: true,
    github_user_id: identity.userId,
    github_username: identity.username,
    organizations_updated: memberships.length,
    installer_orgs_linked: autoLinkedCount,
    github_orgs_joined: autoJoinedCount,
  });
});

/**
 * GET /me
 * Get the current user's identity information including GitHub link status
 */
app.get("/me", async (c) => {
  const auth = c.get("auth");

  // Fetch user details and linked account in parallel
  const dbClient = getDbClient(c.env);
  const [user, memberships, linkedGitHubAccount] = await Promise.all([
    loadBetterAuthUser(auth.userId, c.env),
    dbClient.query("organization_members:listByUser", {
      userId: auth.userId,
      limit: 1,
    }) as Promise<OrganizationMemberDoc[]>,
    loadLatestGitHubAccount(auth.userId, c.env),
  ]);

  if (!user) {
    console.error(`Failed to load Better Auth user for ${auth.userId}`);
    return c.json({ error: "Failed to fetch user details" }, 500);
  }

  const { firstName, lastName } = splitDisplayName(user.name);
  const membership = memberships[0] ?? null;

  // If no organization membership found, fall back to linked GitHub account.
  let githubUserId: string | null = membership?.providerUserId ?? null;
  let githubUsername: string | null = membership?.providerUsername ?? null;
  let githubLinked = Boolean(githubUserId);

  if (!githubLinked && linkedGitHubAccount) {
    githubLinked = true;
    const linkedIdentity = await getGitHubIdentityFromLinkedAccount(
      linkedGitHubAccount.accountId
    );
    if (linkedIdentity) {
      githubUserId = linkedIdentity.userId;
      githubUsername = linkedIdentity.username;
    } else {
      githubUserId = linkedGitHubAccount.accountId;
    }
  }

  return c.json({
    user_id: auth.userId,
    email: user.email,
    first_name: firstName,
    last_name: lastName,
    github_linked: githubLinked,
    github_user_id: githubUserId,
    github_username: githubUsername,
  });
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
  accountNotLinked?: boolean;
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
 * against the Better Auth linked GitHub account. Also validates that the token
 * has required scopes.
 * Returns the GitHub user data and scopes if verified, or failure info otherwise.
 */
const verifyGitHubTokenOwnership = async (
  githubToken: string,
  linkedGitHubAccountId: string | null
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

  if (!linkedGitHubAccountId) {
    return { success: false, accountNotLinked: true };
  }

  const matchesAccount =
    String(githubUser.id) === linkedGitHubAccountId ||
    githubUser.login.toLowerCase() === linkedGitHubAccountId.toLowerCase();

  if (!matchesAccount) {
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

type OptionalTokenResult =
  | { success: true; token: string }
  | { success: false; reason: string };

/**
 * Get a verified GitHub token from the X-GitHub-Token header
 * Validates format, verifies token ownership, and checks required scopes
 */
const getVerifiedGitHubToken = async (
  providedToken: string | undefined,
  linkedGitHubAccountId: string | null
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
    linkedGitHubAccountId
  );

  if (!verifyResult.success) {
    if (verifyResult.accountNotLinked) {
      return {
        success: false,
        error:
          "GitHub account not linked. Please sign in with GitHub before using this endpoint.",
        code: "github_account_not_linked",
        status: 401,
      };
    }
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
 * Validate an optional GitHub token for ownership/scope.
 * Returns failure reason instead of HTTP status because callers may fall back.
 */
const getVerifiedOptionalGitHubToken = async (
  providedToken: string,
  linkedGitHubAccountId: string | null
): Promise<OptionalTokenResult> => {
  if (!isValidGitHubTokenFormat(providedToken)) {
    return { success: false, reason: "invalid_token_format" };
  }

  const verifyResult = await verifyGitHubTokenOwnership(
    providedToken,
    linkedGitHubAccountId
  );

  if (!verifyResult.success) {
    if (verifyResult.accountNotLinked) {
      return { success: false, reason: "github_account_not_linked" };
    }
    if (verifyResult.rateLimited) {
      return { success: false, reason: "rate_limit_exceeded" };
    }
    if (verifyResult.missingScopes && verifyResult.missingScopes.length > 0) {
      return { success: false, reason: "missing_scopes" };
    }
    return { success: false, reason: "token_verification_failed" };
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
 * Uses X-GitHub-Token when provided; otherwise falls back to the linked
 * Better Auth GitHub account access token.
 */
app.get("/github-orgs", async (c) => {
  const auth = c.get("auth");
  const linkedGitHubAccount = await loadLatestGitHubAccount(auth.userId, c.env);
  const providedToken = c.req.header("X-GitHub-Token");

  let githubToken: string | null = null;
  if (providedToken) {
    const tokenResult = await getVerifiedGitHubToken(
      providedToken,
      linkedGitHubAccount?.accountId ?? null
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

    githubToken = tokenResult.token;
  } else if (
    linkedGitHubAccount?.accessToken &&
    isValidGitHubTokenFormat(linkedGitHubAccount.accessToken)
  ) {
    githubToken = linkedGitHubAccount.accessToken;
  }

  if (!githubToken) {
    return c.json(
      {
        error:
          "GitHub token required. Re-authenticate with `dt auth login --force` after linking GitHub.",
        code: "github_token_required",
      },
      401
    );
  }

  // Fetch all orgs with pagination (users can belong to >100 orgs)
  const githubOrgs: GitHubOrg[] = [];
  let url: string | null = "https://api.github.com/user/orgs?per_page=100";

  while (url) {
    const orgsResponse: Response = await fetch(url, {
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

    const pageOrgs = (await orgsResponse.json()) as GitHubOrg[];
    githubOrgs.push(...pageOrgs);

    const linkHeader: string | null = orgsResponse.headers.get("link");
    const nextMatch: RegExpMatchArray | null | undefined = linkHeader?.match(
      GITHUB_LINK_NEXT_REGEX
    );
    url = nextMatch?.[1] ?? null;
  }

  if (githubOrgs.length === 0) {
    return c.json({ orgs: [] });
  }

  const membershipLookups = await mapWithConcurrency(
    githubOrgs,
    GITHUB_MEMBERSHIP_CONCURRENCY,
    (org) => fetchGitHubOrgMembership(org.login, githubToken)
  );

  const rateLimitedLookup = membershipLookups.find(
    (lookup) => lookup.rateLimited
  );
  if (rateLimitedLookup) {
    return c.json(
      {
        error: "GitHub API rate limit exceeded. Please try again later.",
        code: "rate_limit_exceeded",
      },
      429
    );
  }

  const hardFailure = membershipLookups.find(
    (lookup) => typeof lookup.hardFailureStatus === "number"
  );
  if (hardFailure) {
    const status = hardFailure.hardFailureStatus === 401 ? 401 : 502;
    return c.json(
      {
        error: "Failed to verify GitHub organization memberships",
        code: "github_membership_check_failed",
      },
      status
    );
  }

  const membershipMap = new Map(
    membershipLookups.map((lookup) => [lookup.org, lookup.membership])
  );

  // Query our database to find which orgs are already installed
  const dbClient = getDbClient(c.env);
  const githubOrgIds = githubOrgs.map((org) => String(org.id));
  const installedOrgs = (await dbClient.query(
    "organizations:listByProviderAccountIds",
    {
      provider: "github",
      providerAccountIds: githubOrgIds,
      includeDeleted: false,
    }
  )) as OrganizationDoc[];

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
      ...(installedOrg && { detent_org_id: installedOrg._id }),
    };
  });

  return c.json({ orgs: orgsWithStatus });
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
  const linkedGitHubAccount = await loadLatestGitHubAccount(auth.userId, c.env);

  // Verify the new token belongs to the authenticated user
  const verifyResult = await verifyGitHubTokenOwnership(
    successData.access_token,
    linkedGitHubAccount?.accountId ?? null
  );

  if (!verifyResult.success) {
    if (verifyResult.accountNotLinked) {
      return c.json(
        {
          error:
            "GitHub account not linked. Please sign in with GitHub before refreshing tokens.",
          code: "github_account_not_linked",
        },
        401
      );
    }
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

  const appName = "detent-app";
  const url = `https://github.com/apps/${appName}/installations/new?target_id=${targetId}`;

  return c.json({ url });
});

/**
 * GET /organizations
 * List organizations the user is an active member of
 */
app.get("/organizations", async (c) => {
  const auth = c.get("auth");

  const dbClient = getDbClient(c.env);
  const memberships = (await dbClient.query("organization_members:listByUser", {
    userId: auth.userId,
    limit: 500,
  })) as OrganizationMemberDoc[];

  const activeMemberships = memberships.filter((m) => !m.removedAt);
  const orgIds = Array.from(
    new Set(activeMemberships.map((m) => m.organizationId))
  );

  const orgs = await Promise.all(
    orgIds.map((id) => dbClient.query("organizations:getById", { id }))
  );

  const orgById = new Map<string, OrganizationDoc>();
  for (const org of orgs) {
    if (org) {
      orgById.set((org as OrganizationDoc)._id, org as OrganizationDoc);
    }
  }

  return c.json({
    organizations: activeMemberships
      .map((membership) => {
        const org = orgById.get(membership.organizationId);
        if (!org || org.deletedAt) {
          return null;
        }
        return {
          organization_id: membership.organizationId,
          organization_name: org.name,
          organization_slug: org.slug,
          github_org: org.providerAccountLogin,
          provider_account_type: org.providerAccountType,
          role: membership.role,
          github_linked: Boolean(membership.providerUserId),
          github_username: membership.providerUsername,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null),
  });
});

export default app;
