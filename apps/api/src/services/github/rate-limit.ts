import type { RateLimitInfo } from "./types";

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
  return {
    limit: Number.parseInt(limit, 10),
    remaining: Number.parseInt(remaining, 10),
    reset: new Date(resetTimestamp),
    isExceeded: Number.parseInt(remaining, 10) === 0,
  };
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
