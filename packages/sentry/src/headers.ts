/**
 * HTTP header scrubbing utilities
 * SECURITY: Removes sensitive headers before sending to error tracking
 */

import { scrubString } from "./scrub.js";

/**
 * Headers that should never be sent to error tracking (exact match, lowercase)
 * SECURITY: Comprehensive list of sensitive HTTP headers
 */
export const SENSITIVE_HEADERS = new Set([
  // Authentication
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",

  // Session/Cookies
  "cookie",
  "set-cookie",

  // Custom auth headers
  "x-api-key",
  "x-api-secret",
  "x-auth-token",
  "x-access-token",
  "x-refresh-token",
  "x-session-id",
  "x-csrf-token",
  "x-xsrf-token",

  // IP/Location (can reveal internal infrastructure)
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",

  // AWS headers
  "x-amz-security-token",
  "x-amz-credential",
]);

/**
 * Pattern to match sensitive header substrings in a single check
 * More efficient than multiple .includes() calls
 */
const SENSITIVE_HEADER_PATTERN = /token|authorization|cookie|secret|key/i;

/**
 * Check if a header name is sensitive
 * Uses exact match first (fast Set lookup), then falls back to pattern matching
 */
export const isSensitiveHeader = (headerName: string): boolean => {
  const lowerKey = headerName.toLowerCase();
  // Fast path: exact match in Set
  if (SENSITIVE_HEADERS.has(lowerKey)) {
    return true;
  }
  // Slow path: substring match via single regex
  return SENSITIVE_HEADER_PATTERN.test(headerName);
};

/**
 * Scrub request headers, removing sensitive ones entirely
 * and scrubbing values of non-sensitive headers
 *
 * Performance: Uses Object.keys() iteration instead of Object.entries()
 */
export const scrubHeaders = (
  headers: Record<string, string>
): Record<string, string> => {
  const safeHeaders: Record<string, string> = {};

  for (const key of Object.keys(headers)) {
    if (!isSensitiveHeader(key)) {
      const value = headers[key];
      safeHeaders[key] = typeof value === "string" ? scrubString(value) : "";
    }
  }
  return safeHeaders;
};
