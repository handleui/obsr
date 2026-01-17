// Async utilities for Cloudflare Workers

/**
 * Sleep for a given number of milliseconds.
 * Safe to use in Cloudflare Workers (setTimeout is supported).
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a function with exponential backoff.
 * Useful for handling transient failures (e.g., GitHub API race conditions).
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {}
): Promise<T> => {
  const {
    maxRetries = 2,
    initialDelayMs = 1000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        onRetry?.(attempt + 1, error);
        await sleep(delay);
        delay *= backoffMultiplier;
      }
    }
  }

  throw lastError;
};
