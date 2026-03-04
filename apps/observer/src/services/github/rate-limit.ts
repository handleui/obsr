import type { RateLimitInfo } from "./types";

// Minimum remaining requests before we skip optional API calls (like job fetching)
// This provides a safety buffer to ensure critical operations (check runs, comments) succeed
export const RATE_LIMIT_SAFETY_THRESHOLD = 100;

// Module-level rate limit state (persists within Worker isolate).
// IMPORTANT: This state is shared across ALL concurrent requests in the same
// Worker isolate, not just per-request. This is intentional for rate limiting
// (best-effort optimization) but the behavior may be surprising for other uses.
// Updated on every API response to track current quota.
// Using object container to allow mutation while satisfying linter.
const rateLimitState: { current: RateLimitInfo | null } = { current: null };

/**
 * Get the last known rate limit info from any API response.
 * Returns null if no API calls have been made yet in this isolate.
 */
export const getLastKnownRateLimit = (): RateLimitInfo | null => {
  return rateLimitState.current;
};

/**
 * Update the cached rate limit state from a response.
 * Called internally after parsing headers.
 */
const updateRateLimitState = (info: RateLimitInfo | null): void => {
  if (info) {
    rateLimitState.current = info;
  }
};

/**
 * Check if we have enough rate limit headroom for optional API calls.
 * Returns true if safe to proceed, false if we should skip to preserve quota.
 */
export const hasRateLimitHeadroom = (
  threshold = RATE_LIMIT_SAFETY_THRESHOLD
): boolean => {
  if (!rateLimitState.current) {
    // No data yet, assume safe (first request in isolate)
    return true;
  }
  return rateLimitState.current.remaining > threshold;
};

export const parseRateLimitHeaders = (
  response: Response
): RateLimitInfo | null => {
  const limit = response.headers.get("x-ratelimit-limit");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");

  if (!(limit && remaining && reset)) {
    return null;
  }

  const resetTimestamp = Number.parseInt(reset, 10) * 1000;
  const info: RateLimitInfo = {
    limit: Number.parseInt(limit, 10),
    remaining: Number.parseInt(remaining, 10),
    reset: new Date(resetTimestamp),
    isExceeded: Number.parseInt(remaining, 10) === 0,
  };

  // Update module-level state for rate limit checks
  updateRateLimitState(info);

  return info;
};

export const logRateLimitWarning = (
  rateLimitInfo: RateLimitInfo | null,
  context: string
): void => {
  if (!rateLimitInfo) {
    return;
  }

  const { remaining, limit, reset } = rateLimitInfo;
  const percentRemaining = (remaining / limit) * 100;

  if (percentRemaining < 10) {
    console.warn(
      `[github] Rate limit warning for ${context}: ${remaining}/${limit} remaining (resets at ${reset.toISOString()})`
    );
  }
};

export const createRateLimitError = (
  response: Response,
  rateLimitInfo: RateLimitInfo | null,
  context: string
): Error => {
  if (rateLimitInfo?.isExceeded) {
    const retryAfter = response.headers.get("retry-after");
    const resetTime = rateLimitInfo.reset.toISOString();
    return new Error(
      `Rate limit exceeded for ${context}. ` +
        `Resets at ${resetTime}` +
        (retryAfter ? `. Retry after ${retryAfter}s` : "")
    );
  }
  return new Error(`GitHub API error for ${context}: ${response.status}`);
};

export const handleApiError = async (
  response: Response,
  rateLimitInfo: RateLimitInfo | null,
  context: string,
  errorMessages: { 404?: string; 422?: string }
): Promise<never> => {
  if (
    (response.status === 403 || response.status === 429) &&
    rateLimitInfo?.isExceeded
  ) {
    throw createRateLimitError(response, rateLimitInfo, context);
  }

  const error = await response.text();

  if (response.status === 404 && errorMessages[404]) {
    throw new Error(`${context}: ${errorMessages[404]}`);
  }
  if (response.status === 422 && errorMessages[422]) {
    throw new Error(`${context}: ${errorMessages[422]} ${error}`);
  }

  throw new Error(
    `${context}: API request failed - ${response.status} ${error}`
  );
};
