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
  INSTALLATION_TOKEN: 50 * 60 * 1000, // 50 minutes - tokens last 60min
  ORG_SETTINGS: 2 * 60 * 1000, // 2 minutes - settings change rarely via admin UI
};

// Cache key builders
export const cacheKey = {
  orgSettings: (installationId: number | string) =>
    `org-settings:${installationId}`,
};
