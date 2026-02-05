/**
 * Credential Sanitization Utilities
 *
 * Shared regex patterns and functions for sanitizing sensitive
 * information from error messages and logs.
 */

/** Regex patterns for detecting and redacting sensitive credentials */
export const CREDENTIAL_PATTERNS = {
  bearer: /Bearer\s+[^\s]+/gi,
  apiKey: /dtk_[^\s"']+/gi,
  token: /token[=:]\s*[^\s"']+/gi,
  accessToken: /"?access_token"?\s*[:=]\s*[^\s,}]+/gi,
  refreshToken: /"?refresh_token"?\s*[:=]\s*[^\s,}]+/gi,
  jwt: /"?jwt"?\s*[:=]\s*[^\s,}]+/gi,
} as const;

/** Redaction placeholders for each credential type */
const REDACTION_MAP: Record<keyof typeof CREDENTIAL_PATTERNS, string> = {
  bearer: "Bearer [REDACTED]",
  apiKey: "[REDACTED_KEY]",
  token: "token=[REDACTED]",
  accessToken: "access_token=[REDACTED]",
  refreshToken: "refresh_token=[REDACTED]",
  jwt: "jwt=[REDACTED]",
};

/**
 * Sanitize a message by replacing all credential patterns with redacted placeholders.
 *
 * @param message - The message to sanitize
 * @returns The sanitized message with all credentials redacted
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeCredentials("Bearer abc123 failed");
 * // Returns: "Bearer [REDACTED] failed"
 * ```
 */
export const sanitizeCredentials = (message: string): string => {
  let result = message;
  for (const [key, pattern] of Object.entries(CREDENTIAL_PATTERNS)) {
    result = result.replace(
      pattern,
      REDACTION_MAP[key as keyof typeof CREDENTIAL_PATTERNS]
    );
  }
  return result;
};
