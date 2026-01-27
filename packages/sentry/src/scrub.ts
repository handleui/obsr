/**
 * Core scrubbing utilities for removing sensitive data
 * SECURITY: Used to remove PII before sending to external services (Sentry, Better Stack)
 */

/**
 * Combined regex for sensitive patterns - more efficient than iterating multiple patterns
 * Uses non-capturing groups and alternation for single-pass matching
 * SECURITY: All patterns use bounded quantifiers to prevent ReDoS attacks
 *
 * Patterns matched:
 * - token=, api_key=, apikey=, password=, secret=, auth=, session_id=, sessionid= followed by values
 * - Bearer tokens
 * - OAuth codes (20+ chars)
 * - Basic auth in URLs (http://user:pass@host)
 * - JWT tokens (three base64 segments)
 * - GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
 * - Stripe keys (sk_live_, pk_live_, sk_test_, pk_test_)
 * - AWS access key IDs (AKIA...)
 * - Private key markers
 * - Email addresses (bounded to prevent ReDoS)
 * - Credit card numbers
 * - SSN patterns (US format)
 * - Phone numbers (US/CA and international E.164 formats)
 */
const SENSITIVE_COMBINED_PATTERN =
  /(?:(?:access[_-]?token|refresh[_-]?token|session[_-]?id|api[_-]?key|private[_-]?key|password|passphrase|secret|token|auth|credential)[=:][^&\s]*)|(?:bearer\s+[^\s]+)|(?:code[=:][^&\s]{20,})|(?::\/\/[^:]{1,100}:[^@]{1,100}@)|(?:eyJ[A-Za-z0-9_-]{10,500}\.eyJ[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500})|(?:gh[pousr]_[A-Za-z0-9]{36,255})|(?:[sp]k_(?:live|test)_[A-Za-z0-9]{20,255})|(?:AKIA[A-Z0-9]{16})|(?:-----BEGIN\s{1,10}(?:RSA\s{1,10})?PRIVATE\s{1,10}KEY-----)|(?:[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,10})|(?:\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{1,7}\b)|(?:\b\d{3}-\d{2}-\d{4}\b)|(?:\+\d{7,15}\b)|(?:\+\d{1,4}[-.\s]\d{1,5}[-.\s]?\d{1,5}[-.\s]?\d{1,5}\b)|(?:(?:\+1[-.\s]?)?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}\b)|(?:\b\+?1?[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)/gi;

/**
 * Individual patterns exported for testing and external use
 * SECURITY: All patterns use bounded quantifiers to prevent ReDoS attacks
 *
 * WARNING: These patterns have the global (/g) flag. When reusing them directly,
 * you must reset lastIndex to 0 before each use, or the regex may skip matches
 * due to stateful lastIndex behavior. Example:
 *   pattern.lastIndex = 0;
 *   const match = pattern.test(str);
 */
export const SENSITIVE_PATTERNS = [
  // Auth tokens and credentials in query strings/headers
  /token[=:][^&\s]*/gi,
  /api[_-]?key[=:][^&\s]*/gi,
  /password[=:][^&\s]*/gi,
  /secret[=:][^&\s]*/gi,
  /auth[=:][^&\s]*/gi,
  /bearer\s+[^\s]+/gi,
  /session[_-]?id[=:][^&\s]*/gi,
  /access[_-]?token[=:][^&\s]*/gi,
  /refresh[_-]?token[=:][^&\s]*/gi,
  /code[=:][^&\s]{20,}/gi,

  // Basic auth in URLs (http://user:pass@host)
  /:\/\/[^:]{1,100}:[^@]{1,100}@/gi,

  // JWT tokens (three base64 segments separated by dots)
  /eyJ[A-Za-z0-9_-]{10,500}\.eyJ[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{10,500}/g,

  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /gh[pousr]_[A-Za-z0-9]{36,255}/g,

  // Stripe keys (sk_live_, pk_live_, sk_test_, pk_test_)
  /[sp]k_(?:live|test)_[A-Za-z0-9]{20,255}/g,

  // AWS access key IDs (AKIA...)
  /AKIA[A-Z0-9]{16}/g,

  // Private key markers
  /-----BEGIN\s{1,10}(?:RSA\s{1,10})?PRIVATE\s{1,10}KEY-----/g,

  // Email patterns (bounded to prevent ReDoS)
  /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,10}/g,

  // Credit card numbers (13-19 digits, with or without separators)
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{1,7}\b/g,

  // SSN patterns (US format)
  /\b\d{3}-\d{2}-\d{4}\b/g,

  // Phone numbers (US/CA and international formats)
  // E.164 format: +[7-15 digits]
  /\+\d{7,15}\b/g,
  // International with separators: +[country code] [groups]
  /\+\d{1,4}[-.\s]\d{1,5}[-.\s]?\d{1,5}[-.\s]?\d{1,5}\b/g,
  // US/CA format with parentheses: (555) 123-4567, +1 (555) 123-4567
  /(?:\+1[-.\s]?)?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // US/CA format without parentheses: 555-123-4567, +1 555-123-4567
  /\b\+?1?[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
];

/**
 * Keys that should always be redacted (normalized without dashes/underscores)
 * SECURITY: Comprehensive list of sensitive key names
 */
export const SENSITIVE_KEYS = new Set([
  // Authentication
  "token",
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "accesstoken",
  "refreshtoken",
  "sessionid",
  "jwt",
  "bearer",

  // Cryptographic
  "privatekey",
  "publickey",
  "passphrase",
  "salt",
  "nonce",
  "signature",
  "cert",
  "certificate",

  // Personal data
  "ssn",
  "socialsecurity",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
  "otp",

  // Cloud/Service credentials
  "awsaccesskeyid",
  "awssecretaccesskey",
  "connectionstring",
  "databaseurl",
]);

/**
 * Scrub sensitive data from a string value
 * SECURITY: Removes patterns that may contain tokens, passwords, etc.
 *
 * Performance: Uses a single combined regex instead of iterating 11 patterns
 */
export const scrubString = (value: string): string => {
  // Reset lastIndex for safety (regex has g flag)
  SENSITIVE_COMBINED_PATTERN.lastIndex = 0;
  return value.replace(SENSITIVE_COMBINED_PATTERN, "[REDACTED]");
};

/**
 * Scrub sensitive data from a string value, handling null/undefined
 * SECURITY: Removes patterns that may contain tokens, passwords, etc.
 * Returns undefined for null/undefined inputs, preserves empty strings
 */
export const scrubStringNullable = (
  value: string | undefined | null
): string | undefined => {
  if (value == null) {
    return undefined;
  }
  return scrubString(value);
};

/**
 * Check if a key should be redacted based on SENSITIVE_KEYS
 */
export const isSensitiveKey = (key: string): boolean => {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEYS.has(normalizedKey);
};

/**
 * Maximum recursion depth to prevent stack overflow on deeply nested objects
 * SECURITY: Protects against DoS via maliciously deep objects
 */
const MAX_DEPTH = 20;

/**
 * Internal recursive scrub with circular reference tracking and depth limit
 * @internal
 */
const scrubObjectInternal = (
  obj: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> => {
  // SECURITY: Prevent stack overflow from deep nesting
  if (depth > MAX_DEPTH) {
    return { "[TRUNCATED]": "max depth exceeded" };
  }

  // SECURITY: Detect circular references
  if (seen.has(obj)) {
    return { "[CIRCULAR]": true };
  }
  seen.add(obj);

  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    // Redact keys that might contain sensitive data
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string") {
      result[key] = scrubString(value);
    } else if (Array.isArray(value)) {
      result[key] = scrubArrayInternal(value, seen, depth + 1);
    } else if (value !== null && typeof value === "object") {
      result[key] = scrubObjectInternal(
        value as Record<string, unknown>,
        seen,
        depth + 1
      );
    } else {
      result[key] = value;
    }
  }
  return result;
};

/**
 * Internal recursive array scrub with circular reference tracking and depth limit
 * @internal
 */
const scrubArrayInternal = (
  arr: unknown[],
  seen: WeakSet<object>,
  depth: number
): unknown[] => {
  // SECURITY: Prevent stack overflow from deep nesting
  if (depth > MAX_DEPTH) {
    return ["[TRUNCATED: max depth exceeded]"];
  }

  // SECURITY: Detect circular references
  if (seen.has(arr)) {
    return ["[CIRCULAR]"];
  }
  seen.add(arr);

  const result = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item === "string") {
      result[i] = scrubString(item);
    } else if (Array.isArray(item)) {
      result[i] = scrubArrayInternal(item, seen, depth + 1);
    } else if (item !== null && typeof item === "object") {
      result[i] = scrubObjectInternal(
        item as Record<string, unknown>,
        seen,
        depth + 1
      );
    } else {
      result[i] = item;
    }
  }
  return result;
};

/**
 * Recursively scrub sensitive data from an object
 * SECURITY: Removes or redacts keys/values that may contain PII
 * SECURITY: Handles circular references and limits depth to prevent DoS
 */
export const scrubObject = (
  obj: Record<string, unknown>
): Record<string, unknown> => {
  return scrubObjectInternal(obj, new WeakSet(), 0);
};
