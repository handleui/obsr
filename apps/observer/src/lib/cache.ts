/**
 * Simple TTL cache for reducing external API calls
 * Works within a single Cloudflare Worker isolate
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export const getFromCache = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value as T;
};

export const setInCache = <T>(key: string, value: T, ttlMs: number): void => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

export const deleteFromCache = (key: string): void => {
  cache.delete(key);
};

// Cache TTLs
export const CACHE_TTL = {
  GITHUB_IDENTITY: 5 * 60 * 1000, // 5 minutes - identity rarely changes
  GITHUB_MEMBERSHIP: 2 * 60 * 1000, // 2 minutes - membership can change
  GITHUB_ORG_MEMBERS: 5 * 60 * 1000, // 5 minutes - full member list for sync
  INSTALLATION_TOKEN: 50 * 60 * 1000, // 50 minutes - tokens last 60min
  ORG_SETTINGS: 2 * 60 * 1000, // 2 minutes - settings change rarely via admin UI
};

/**
 * Cache key builders for consistent key generation across the application.
 * Used for both in-memory cache and KV storage to ensure cache invalidation
 * works correctly across both tiers.
 *
 * Two-tier caching strategy:
 * - In-memory: Fast, per-isolate, short TTL (2-5 min)
 * - KV: Persistent across isolates, eventually consistent, longer TTL (1hr)
 *
 * Using the same key format for both ensures:
 * 1. Cache invalidation (webhook) clears both tiers with one key
 * 2. KV->memory population uses consistent keys
 * 3. No key collision between different cache tiers
 */
export const cacheKey = {
  /**
   * Generates a cache key for organization settings.
   * @param installationId - The GitHub App installation ID (number from webhook payloads)
   */
  orgSettings: (installationId: number | string) =>
    `org-settings:${installationId}`,

  /**
   * Generates a cache key for GitHub org member list.
   * Used for both in-memory and KV caching.
   *
   * TRADE-OFF: Uses orgLogin (mutable) instead of providerAccountId (immutable).
   * If an org is renamed on GitHub, the old cache key will remain until TTL expires.
   * This is acceptable because:
   * - Org renames are rare
   * - In-memory TTL is only 5 minutes (GITHUB_ORG_MEMBERS)
   * - Webhooks invalidate the cache on member changes
   * - Sync job runs periodically and refreshes data
   * - Using providerAccountId would require an extra DB lookup in hot paths
   *
   * @param orgLogin - The GitHub organization login (e.g., "acme-corp")
   */
  githubOrgMembers: (orgLogin: string) => `github-org-members:${orgLogin}`,
};
