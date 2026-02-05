import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Context, Next } from "hono";
import type { Env } from "../types/env";

const cache = new Map<string, number>();
const MAX_CACHE_ENTRIES = 10_000;
const ratelimitInstances = new Map<string, Ratelimit>();

const getRatelimit = (env: Env): Ratelimit => {
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.clear();
  }

  const cacheKey = `public:${env.UPSTASH_REDIS_REST_URL}`;

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
    // 30 requests per minute per IP (stricter for public endpoints)
    limiter: Ratelimit.slidingWindow(30, "1 m"),
    prefix: "detent:ratelimit:public",
    ephemeralCache: cache,
    timeout: 2000,
    analytics: true,
  });

  ratelimitInstances.set(cacheKey, ratelimit);
  return ratelimit;
};

const getClientIp = (c: Context<{ Bindings: Env }>): string => {
  const cfIp = c.req.header("CF-Connecting-IP");
  if (cfIp) {
    return cfIp;
  }

  const xForwardedFor = c.req.header("X-Forwarded-For");
  if (xForwardedFor) {
    return xForwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  return "unknown";
};

export const publicRateLimitMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const clientIp = getClientIp(c);
  const identifier = `ip:${clientIp}`;

  try {
    const ratelimit = getRatelimit(c.env);
    const { success, limit, remaining, reset, pending, reason } =
      await ratelimit.limit(identifier);

    c.executionCtx.waitUntil(pending);

    c.header("X-RateLimit-Limit", limit.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());
    c.header("X-RateLimit-Reset", reset.toString());

    if (reason === "timeout") {
      console.warn("Public rate limit timeout - check Redis connectivity", {
        clientIp,
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
    console.error("Public rate limit check failed:", {
      error: error instanceof Error ? error.message : String(error),
      clientIp,
    });
  }

  await next();
  return undefined;
};
