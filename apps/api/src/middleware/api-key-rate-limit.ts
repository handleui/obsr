/**
 * Rate limiting middleware for API key authenticated routes
 *
 * Uses sliding window algorithm to limit requests per organization.
 * Must be applied AFTER apiKeyAuthMiddleware (requires organizationId from context).
 * Fails open for availability - allows requests if Redis is unavailable.
 *
 * Configured for CI/CD systems with higher limits (100 req/min per org)
 * since batch requests are common during workflow runs.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Context, Next } from "hono";
import type { Env } from "../types/env";

// Ephemeral cache to reduce Redis calls
// Note: Module-level state persists within a Cloudflare Workers isolate but not
// across isolates. Different requests may hit different isolates with different
// cache states. This is acceptable for ephemeral caching purposes.
const cache = new Map<string, number>();

// Max cache entries before clearing to prevent unbounded memory growth
const MAX_CACHE_ENTRIES = 10_000;

// Cache Ratelimit instances per environment (keyed by Redis URL)
const ratelimitInstances = new Map<string, Ratelimit>();

const getRatelimit = (env: Env): Ratelimit => {
  // Clear ephemeral cache if it grows too large to prevent unbounded memory growth
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.clear();
  }

  const cacheKey = `apikey:${env.UPSTASH_REDIS_REST_URL}`;

  const existing = ratelimitInstances.get(cacheKey);
  if (existing) {
    return existing;
  }

  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });

  const ratelimit = new Ratelimit({
    redis,
    // 100 requests per minute per organization (more lenient for CI systems)
    limiter: Ratelimit.slidingWindow(100, "1 m"),
    prefix: "detent:ratelimit:apikey",
    ephemeralCache: cache,
    timeout: 2000,
    analytics: true,
  });

  ratelimitInstances.set(cacheKey, ratelimit);
  return ratelimit;
};

export const apiKeyRateLimitMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const apiKeyAuth = c.get("apiKeyAuth");

  if (!apiKeyAuth?.organizationId) {
    console.error("API key rate limit middleware: missing apiKeyAuth context");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const identifier = `org:${apiKeyAuth.organizationId}`;

  try {
    const ratelimit = getRatelimit(c.env);
    const { success, limit, remaining, reset, pending, reason } =
      await ratelimit.limit(identifier);

    // Handle analytics in background (for Cloudflare Workers)
    c.executionCtx.waitUntil(pending);

    c.header("X-RateLimit-Limit", limit.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());
    c.header("X-RateLimit-Reset", reset.toString());

    // Log timeout events for monitoring
    if (reason === "timeout") {
      console.warn("API key rate limit timeout - check Redis connectivity", {
        organizationId: apiKeyAuth.organizationId,
      });
    }

    if (!success) {
      return c.json(
        {
          error: "Rate limit exceeded",
          retryAfter: reset,
        },
        429
      );
    }
  } catch (error) {
    // Fail open for availability - allow request if Redis fails
    console.error("API key rate limit check failed:", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: apiKeyAuth.organizationId,
    });
  }

  await next();
  return undefined;
};
