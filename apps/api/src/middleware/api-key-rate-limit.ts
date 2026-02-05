/**
 * Rate limiting middleware for API key authenticated routes
 *
 * Uses sliding window algorithm to limit requests per organization.
 * Must be applied AFTER apiKeyAuthMiddleware (requires organizationId from context).
 * Fails open for availability - allows requests if Redis is unavailable,
 * but uses an in-memory fallback rate limiter for defense-in-depth.
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

// ============================================================================
// In-Memory Fallback Rate Limiter (Token Bucket)
// ============================================================================
// Activates when Redis is unavailable. More conservative than Redis limiter
// to prevent abuse during outages while still allowing legitimate traffic.

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

// Fallback rate limiter state
const fallbackBuckets = new Map<string, TokenBucket>();
const MAX_FALLBACK_BUCKETS = 5000;

// Fallback limits (more conservative than Redis: 30 req/min vs 100 req/min)
const FALLBACK_MAX_TOKENS = 30;
const FALLBACK_REFILL_RATE = 0.5; // tokens per second (30/min)
const FALLBACK_WINDOW_MS = 60_000; // 1 minute window for cleanup

/**
 * Metrics for monitoring/alerting on Redis failures.
 *
 * This object is module-scoped and mutated directly (lines 170-172) without locks.
 * Thread-safety is guaranteed because:
 * 1. Cloudflare Workers execute each request in a dedicated V8 isolate
 * 2. V8 isolates are single-threaded and cannot be shared across threads
 * 3. Each isolate maintains its own copy of this module's state
 *
 * Mutation of these counters is safe as long as each isolate only modifies its own instance.
 */
export const failOpenMetrics = {
  count: 0,
  lastOccurrence: 0,
  lastIdentifier: "",
};

/**
 * Simple token bucket rate limiter for fallback when Redis is unavailable.
 * Returns true if request is allowed, false if rate limited.
 */
const checkFallbackRateLimit = (identifier: string): boolean => {
  const now = Date.now();

  // Cleanup old buckets periodically to prevent unbounded memory growth
  if (fallbackBuckets.size > MAX_FALLBACK_BUCKETS) {
    for (const [key, bucket] of fallbackBuckets) {
      if (now - bucket.lastRefill > FALLBACK_WINDOW_MS * 2) {
        fallbackBuckets.delete(key);
      }
    }
  }

  let bucket = fallbackBuckets.get(identifier);

  if (bucket) {
    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsed * FALLBACK_REFILL_RATE;
    bucket.tokens = Math.min(FALLBACK_MAX_TOKENS, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  } else {
    // New identifier gets full bucket
    bucket = { tokens: FALLBACK_MAX_TOKENS, lastRefill: now };
    fallbackBuckets.set(identifier, bucket);
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
};

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
    // Track fail-open event for monitoring/alerting
    failOpenMetrics.count += 1;
    failOpenMetrics.lastOccurrence = Date.now();
    failOpenMetrics.lastIdentifier = identifier;

    console.error("API key rate limit check failed, using fallback:", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: apiKeyAuth.organizationId,
      failOpenCount: failOpenMetrics.count,
    });

    // Use in-memory fallback rate limiter as defense-in-depth
    // More conservative than Redis (30 req/min vs 100 req/min)
    const allowed = checkFallbackRateLimit(identifier);

    if (!allowed) {
      console.warn("Fallback rate limit exceeded during Redis outage", {
        organizationId: apiKeyAuth.organizationId,
        identifier,
      });

      return c.json(
        {
          error: "Rate limit exceeded",
          retryAfter: Date.now() + 60_000, // Suggest retry in 1 minute
        },
        429
      );
    }

    // Set fallback headers to indicate degraded mode
    c.header("X-RateLimit-Limit", FALLBACK_MAX_TOKENS.toString());
    c.header("X-RateLimit-Fallback", "true");
  }

  await next();
  return undefined;
};
