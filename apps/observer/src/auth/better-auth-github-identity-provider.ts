import { getBetterAuthPool } from "../lib/better-auth";
import { CACHE_TTL, getFromCache, setInCache } from "../lib/cache";
import type { Env } from "../types/env";
import type {
  GitHubIdentityProvider,
  VerifiedGitHubIdentity,
} from "./github-identity-provider";

interface GitHubUserResponse {
  id: number;
  login: string;
}

const GITHUB_PROVIDER_ID = "github";
const GITHUB_USER_AGENT = "Detent-API";
const NUMERIC_ACCOUNT_ID_PATTERN = /^\d+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGitHubUserResponse = (value: unknown): value is GitHubUserResponse => {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === "number" && typeof value.login === "string";
};

const fetchGitHubUser = async (
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
        "User-Agent": GITHUB_USER_AGENT,
      },
    });

    if (!response.ok) {
      continue;
    }

    const payload = await response.json();
    if (isGitHubUserResponse(payload)) {
      return payload;
    }
  }

  return null;
};

const resolveGitHubAccountId = async (
  authUserId: string,
  env: Env
): Promise<string | null> => {
  const pool = getBetterAuthPool(env);
  const result = await pool.query<{ account_id: string }>(
    `
      SELECT account_id
      FROM account
      WHERE user_id = $1 AND provider_id = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [authUserId, GITHUB_PROVIDER_ID]
  );

  return result.rows[0]?.account_id ?? null;
};

export const betterAuthGitHubIdentityProvider: GitHubIdentityProvider = {
  name: "better-auth",
  getVerifiedGitHubIdentity: async (
    authUserId: string,
    env: Env
  ): Promise<VerifiedGitHubIdentity | null> => {
    const cacheKey = `github-identity:${authUserId}`;
    const cached = getFromCache<VerifiedGitHubIdentity>(cacheKey);
    if (cached) {
      console.log(`[github-identity] Cache hit for ${authUserId}`);
      return cached;
    }

    const accountId = await resolveGitHubAccountId(authUserId, env);
    if (!accountId) {
      return null;
    }

    const githubUser = await fetchGitHubUser(accountId);
    if (!githubUser) {
      return null;
    }

    const result: VerifiedGitHubIdentity = {
      userId: String(githubUser.id),
      username: githubUser.login,
    };

    setInCache(cacheKey, result, CACHE_TTL.GITHUB_IDENTITY);
    console.log(`[github-identity] Cached identity for ${authUserId}`);

    return result;
  },
};
