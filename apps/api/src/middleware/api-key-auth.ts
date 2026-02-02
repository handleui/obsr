/**
 * API Key authentication middleware
 *
 * Validates Detent API keys from the X-Detent-Token header.
 * Sets organizationId in context for downstream handlers.
 * Used for machine-to-machine communication (GitHub Actions, CI integrations).
 *
 * Security measures:
 * - Format validation before DB lookup (prevents invalid queries)
 * - Generic error messages (prevent information leakage)
 * - Cache keyed by hash (defense in depth - no plaintext keys in KV)
 *
 * Performance optimizations:
 * - KV caching for API key lookups (5 minute TTL)
 * - lastUsedAt updates run in background via waitUntil
 * - Selects only needed columns from database
 */

import type { KVNamespace } from "@cloudflare/workers-types";
import type { ConvexHttpClient } from "convex/browser";
import type { Context, Next } from "hono";
import { getConvexClient } from "../db/convex";
import { hashApiKey } from "../lib/crypto";
import type { Env } from "../types/env";

interface ApiKeyAuthContext {
  organizationId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    apiKeyAuth: ApiKeyAuthContext;
  }
}

const API_KEY_PREFIX = "dtk_";
// Expected format: dtk_ + 32 characters = 36 total
const API_KEY_LENGTH = 36;
// Regex for valid API key format: prefix + base64url chars (alphanumeric, -, _)
const API_KEY_PATTERN = /^dtk_[a-zA-Z0-9_-]{32}$/;

// KV cache key prefix for API keys (keyed by hash for security)
const API_KEY_CACHE_PREFIX = "api-key-v2:";

// Cache TTL: 5 minutes (API keys rarely change, but we want invalidation to be quick)
const API_KEY_CACHE_TTL_SECONDS = 300;

interface CachedApiKey {
  _id: string;
  organizationId: string;
  keyHash: string;
}

/**
 * Lookup API key with KV caching
 * Cache is keyed by hash of the token (defense in depth)
 * Falls back to database on cache miss
 */
const lookupApiKey = async (
  tokenHash: string,
  kv: KVNamespace,
  convex: ConvexHttpClient
): Promise<CachedApiKey | null> => {
  // Cache key uses hash - never store plaintext tokens in KV
  const cacheKey = `${API_KEY_CACHE_PREFIX}${tokenHash}`;

  // Try KV cache first
  const cached = await kv.get<CachedApiKey>(cacheKey, "json");
  if (cached) {
    return cached;
  }

  // Cache miss: lookup in database by hash (select only needed columns)
  const apiKey = (await convex.query("api_keys:getByKeyHash", {
    keyHash: tokenHash,
  })) as CachedApiKey | null;

  if (!apiKey) {
    return null;
  }

  const result: CachedApiKey = {
    _id: apiKey._id,
    organizationId: apiKey.organizationId,
    keyHash: apiKey.keyHash,
  };

  // Cache the result (don't await - fire and forget for performance)
  // KV put is fast and eventually consistent anyway
  // Wrap in try-catch for observability without blocking
  kv.put(cacheKey, JSON.stringify(result), {
    expirationTtl: API_KEY_CACHE_TTL_SECONDS,
  }).catch((err) => {
    console.error("[api-key-auth] KV cache write failed:", err);
  });

  return result;
};

export const apiKeyAuthMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const token = c.req.header("X-Detent-Token");

  // Validate token presence - use generic error to avoid info leakage
  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }

  // Validate token format before any DB/KV operations
  // This prevents lookups for obviously invalid tokens and reduces attack surface
  if (
    !token.startsWith(API_KEY_PREFIX) ||
    token.length !== API_KEY_LENGTH ||
    !API_KEY_PATTERN.test(token)
  ) {
    return c.json({ error: "Authentication failed" }, 401);
  }

  const kv = c.env["detent-idempotency"];
  const convex = getConvexClient(c.env);

  try {
    // Hash the provided token for lookup
    const tokenHash = await hashApiKey(token);
    const apiKey = await lookupApiKey(tokenHash, kv, convex);

    if (!apiKey) {
      return c.json({ error: "Authentication failed" }, 401);
    }

    // Update lastUsedAt in background using waitUntil
    // This doesn't block the response and uses a separate connection
    c.executionCtx.waitUntil(
      convex
        .mutation("api_keys:updateLastUsedAt", {
          id: apiKey._id,
          lastUsedAt: Date.now(),
        })
        .catch((err) => {
          console.error("[api-key-auth] lastUsedAt update failed:", err);
        })
    );

    c.set("apiKeyAuth", {
      organizationId: apiKey.organizationId,
    });

    await next();
    return undefined;
  } catch (error) {
    console.error(
      "[api-key-auth] Authentication error:",
      error instanceof Error ? error.message : String(error)
    );
    return c.json({ error: "Authentication failed" }, 401);
  }
};

/**
 * Invalidate cached API key (call when key is deleted)
 * Takes the keyHash directly since plaintext is no longer stored
 */
export const invalidateApiKeyCache = async (
  keyHash: string,
  kv: KVNamespace
): Promise<void> => {
  const cacheKey = `${API_KEY_CACHE_PREFIX}${keyHash}`;
  await kv.delete(cacheKey);
};
