/**
 * Sensitive data scrubbing utilities for security
 * SECURITY: Used to remove PII before sending to external services (Sentry, Better Stack)
 */

/**
 * Patterns that may contain sensitive data in URLs or strings
 */
export const SENSITIVE_PATTERNS = [
  /token[=:][^&\s]*/gi,
  /api[_-]?key[=:][^&\s]*/gi,
  /password[=:][^&\s]*/gi,
  /secret[=:][^&\s]*/gi,
  /auth[=:][^&\s]*/gi,
  /bearer\s+[^\s]+/gi,
  /session[_-]?id[=:][^&\s]*/gi,
  /access[_-]?token[=:][^&\s]*/gi,
  /refresh[_-]?token[=:][^&\s]*/gi,
  /code[=:][^&\s]{20,}/gi, // OAuth codes are typically long
  // Email patterns
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
];

/**
 * Keys that should always be redacted (normalized without dashes/underscores)
 */
export const SENSITIVE_KEYS = new Set([
  "token",
  "password",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "accesstoken",
  "refreshtoken",
  "sessionid",
]);

/**
 * Scrub sensitive data from a string value
 * SECURITY: Removes patterns that may contain tokens, passwords, etc.
 */
export const scrubString = (value: string): string => {
  let scrubbed = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
};

/**
 * Scrub sensitive data from a string value, handling null/undefined
 * SECURITY: Removes patterns that may contain tokens, passwords, etc.
 * Returns undefined for null/undefined inputs (useful in client components)
 */
export const scrubStringNullable = (
  value: string | undefined | null
): string | undefined => {
  if (!value) {
    return undefined;
  }
  return scrubString(value);
};

/**
 * Check if a key should be redacted based on SENSITIVE_KEYS
 */
const isSensitiveKey = (key: string): boolean => {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEYS.has(normalizedKey);
};

/**
 * Recursively scrub sensitive data from an object
 * SECURITY: Removes or redacts keys/values that may contain PII
 */
export const scrubObject = (
  obj: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Redact keys that might contain sensitive data
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      result[key] = scrubString(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = scrubObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === "string") {
          return scrubString(item);
        }
        if (item && typeof item === "object") {
          return scrubObject(item as Record<string, unknown>);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
};
