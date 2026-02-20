/**
 * Normalization rules for error messages to enable cross-repo matching.
 * Moderate normalization: preserve some structure for AI reasoning.
 *
 * Security considerations:
 * - Input is truncated BEFORE regex processing to prevent ReDoS
 * - Sensitive patterns (secrets, tokens, emails) are sanitized
 * - Path normalization removes user-identifiable information
 */

// Maximum input length before regex processing (ReDoS prevention)
const MAX_INPUT_LENGTH = 2000;

// Core normalization patterns
const QUOTED_STRINGS = /['"`][^'"`]*['"`]/g;
const SCOPED_PACKAGES = /@[\w-]+\/[\w-]+/g;
const RELATIVE_IMPORTS = /['"`]\.\.?\/[^'"`]*['"`]/g;
const UNIX_PATHS = /(?:\/[\w.-]+)+(?:\/[\w.-]*)?/g;
const WINDOWS_PATHS = /[A-Z]:\\(?:[\w.-]+\\)+[\w.-]*/gi;
const NUMBERS_NOT_IN_CODES = /(?<![A-Z])\b\d+\b/g;
const WHITESPACE = /\s+/g;
const COMMON_PATH_PREFIXES = /^.*?(?=src\/|lib\/|app\/|packages\/|apps\/)/i;
const BACKSLASH = /\\/g;

// Sensitive data patterns (PII/secrets sanitization)
// API keys, tokens, secrets (common patterns)
const API_KEYS =
  /\b(?:api[_-]?key|token|secret|password|auth|bearer|credential)s?\s*[=:]\s*['"]?[\w-]{8,}['"]?/gi;
// JWT tokens (three base64 segments separated by dots)
const JWT_TOKENS = /\beyJ[\w-]*\.[\w-]*\.[\w-]*/g;
// AWS-style keys
const AWS_KEYS = /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g;
// Generic hex tokens (48+ chars to avoid false positives on commit SHAs/40, MD5/32, SHA-1/40)
// This still catches SHA-256 (64 chars) and longer API keys/tokens
const HEX_TOKENS = /\b[a-fA-F0-9]{48,}\b/g;
// Hex tokens with context (key=, token:, secret:, etc.) - catches shorter hex strings in sensitive context
const CONTEXTUAL_HEX =
  /(?:key|token|secret|password|auth|credential)s?\s*[=:]\s*[a-fA-F0-9]{16,}/gi;
// Email addresses
const EMAIL_ADDRESSES = /\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g;
// IP addresses
const IP_ADDRESSES = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Home directory paths (contains username)
const HOME_PATHS = /(?:\/Users\/|\/home\/|C:\\Users\\)[\w.-]+/gi;

const replaceSensitiveData = (input: string): string =>
  input
    .replace(API_KEYS, "<secret>")
    .replace(JWT_TOKENS, "<token>")
    .replace(AWS_KEYS, "<aws-key>")
    .replace(CONTEXTUAL_HEX, "<hex>")
    .replace(HEX_TOKENS, "<hex>")
    .replace(EMAIL_ADDRESSES, "<email>")
    .replace(IP_ADDRESSES, "<ip>")
    .replace(HOME_PATHS, "<home>");

/** Normalize a message for lore fingerprinting */
export const normalizeForLore = (message: string): string => {
  // SECURITY: Truncate input BEFORE regex processing to prevent ReDoS
  const truncatedInput = message.slice(0, MAX_INPUT_LENGTH);

  return replaceSensitiveData(truncatedInput)
    .replace(QUOTED_STRINGS, "<string>")
    .replace(SCOPED_PACKAGES, "<module>")
    .replace(RELATIVE_IMPORTS, "<module>")
    .replace(UNIX_PATHS, "<path>")
    .replace(WINDOWS_PATHS, "<path>")
    .replace(NUMBERS_NOT_IN_CODES, "<n>")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, 500);
};

/**
 * Sanitize sensitive data from a message without full normalization.
 * Use this for storing example messages where you want to preserve
 * readability but remove PII/secrets.
 */
export const sanitizeSensitiveData = (message: string): string => {
  // SECURITY: Truncate input first
  return replaceSensitiveData(message.slice(0, MAX_INPUT_LENGTH));
};

// Maximum file path length before processing
const MAX_PATH_LENGTH = 1000;

/** Normalize a file path for repo-level fingerprinting */
export const normalizeFilePath = (filePath: string): string => {
  // SECURITY: Truncate before regex processing
  const truncatedPath = filePath.slice(0, MAX_PATH_LENGTH);

  // Convert Windows paths to Unix first
  const unixPath = truncatedPath.replace(BACKSLASH, "/");

  // COMMON_PATH_PREFIXES strips everything before src/lib/app/packages/apps
  // This inherently removes home directory usernames (e.g., /Users/alice/project/src/ -> src/)
  // For paths without these markers, we fall back to stripping home directories explicitly
  const normalized = unixPath.replace(COMMON_PATH_PREFIXES, "");

  // If COMMON_PATH_PREFIXES didn't match (path unchanged and still has home dir),
  // strip the home directory portion for privacy
  const result =
    normalized === unixPath ? unixPath.replace(HOME_PATHS, "") : normalized;

  return result.toLowerCase();
};
