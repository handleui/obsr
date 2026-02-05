/**
 * Secret scrubbing utilities for sanitizing sensitive data from output.
 *
 * Used to prevent accidental exposure of API keys, tokens, and credentials
 * that may appear in CI logs submitted to public endpoints.
 *
 * Pattern coverage:
 * - GitHub tokens (ghp_, gho_, ghr_, ghs_, ghu_, github_pat_)
 * - GitLab PATs (glpat-)
 * - Bearer tokens
 * - Stripe keys (sk_, pk_, rk_ with live/test modes)
 * - JWTs (eyJ...)
 * - Resend keys (re_)
 * - AWS keys (AKIA, ASIA for temp credentials)
 * - OpenAI keys (sk-, sk-proj-, sk-admin-, sk-svcacct-)
 * - Anthropic keys (sk-ant-api03-, sk-ant-admin-)
 * - Detent API keys (dtk_)
 * - Generic env var patterns (KEY=value, SECRET=value, etc.)
 * - Base64-encoded secrets (in assignment context only)
 * - Private keys (-----BEGIN ... PRIVATE KEY-----)
 * - Connection strings with credentials
 * - User home directory paths (PII in file paths)
 */

// Core token patterns - high-confidence matches
const TOKEN_PATTERNS = [
  // GitHub tokens (ghp_, gho_, ghr_, ghs_, ghu_)
  /gh[porsu]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,

  // GitLab PATs
  /glpat-[A-Za-z0-9_-]{20,}/g,

  // Bearer tokens (captures the token value after Bearer)
  /Bearer\s+[A-Za-z0-9._\-/+=]{20,}/gi,

  // Stripe keys (sk_, pk_, rk_ with live/test modes)
  /[spr]k_(?:live|test)_[A-Za-z0-9]{20,}/g,

  // JWTs (three base64url-encoded segments)
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,

  // Resend keys
  /re_[A-Za-z0-9_]{32,}/g,

  // AWS access keys (AKIA for long-term, ASIA for temporary STS credentials)
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,

  // OpenAI keys (sk-, sk-proj-, sk-admin-, sk-svcacct-)
  /sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{32,}/g,

  // Anthropic keys (sk-ant-api03-, sk-ant-admin-)
  /sk-ant-(?:api03-|admin-)[A-Za-z0-9_-]{32,}/g,

  // Vercel tokens
  /vercel_[A-Za-z0-9_]{32,}/gi,

  // npm tokens
  /npm_[A-Za-z0-9]{36,}/g,

  // Slack tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,

  // Discord tokens
  /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,

  // Detent API keys (dtk_ + 32 base64url chars)
  /dtk_[A-Za-z0-9_-]{32}/g,

  // Private keys in PEM format
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g,

  // Base64-encoded secrets (40+ chars, only after assignment operator to avoid
  // false positives on images, source maps, etc.)
  /(?<=[=:]\s*['"]?)[A-Za-z0-9+/]{40,}={0,2}(?=['"]?\s*(?:[,}\]\n\r]|$))/g,
];

// Environment variable patterns - KEY=value format
const ENV_VAR_PATTERN =
  /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY)[\w]*\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi;

// Connection string patterns (postgres, mysql, redis, mongodb with credentials)
const CONNECTION_STRING_PATTERN =
  /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^:]+:[^@]+@[^\s"']+/gi;

// Pattern for finding separator in env var matches
const ENV_VAR_SEPARATOR_PATTERN = /[=:]/;

// User home directory patterns - redact usernames to protect PII
// Unix: /home/username/... -> /home/[USER]/...
const UNIX_HOME_PATH_PATTERN = /\/home\/([^/\s]+)/g;
// macOS: /Users/username/... -> /Users/[USER]/...
const MACOS_HOME_PATH_PATTERN = /\/Users\/([^/\s]+)/g;
// Windows: C:\Users\username\... -> C:\Users\[USER]\...
const WINDOWS_HOME_PATH_PATTERN = /C:\\Users\\([^\\\s]+)/gi;
// Root user path (Docker containers, CI runners)
const ROOT_PATH_PATTERN = /\/root(?=\/)/g;

/**
 * Scrub sensitive data from a string value.
 *
 * Replaces detected secrets with [REDACTED] to prevent exposure.
 * Designed to be fast and safe for use on large inputs (up to 10MB).
 */
export const scrubSecrets = (value: string): string => {
  let result = value;

  // Apply token patterns
  for (const pattern of TOKEN_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }

  // Apply env var pattern
  result = result.replace(ENV_VAR_PATTERN, (match) => {
    // Keep the key name, redact the value
    const eqIndex = match.search(ENV_VAR_SEPARATOR_PATTERN);
    if (eqIndex !== -1) {
      return `${match.slice(0, eqIndex + 1)}[REDACTED]`;
    }
    return "[REDACTED]";
  });

  // Apply connection string pattern
  result = result.replace(CONNECTION_STRING_PATTERN, (match) => {
    // Keep protocol and host, redact credentials
    const atIndex = match.lastIndexOf("@");
    const protocolEnd = match.indexOf("://") + 3;
    if (atIndex !== -1 && protocolEnd > 3) {
      return `${match.slice(0, protocolEnd)}[REDACTED]@${match.slice(atIndex + 1)}`;
    }
    return "[REDACTED]";
  });

  return result;
};

/**
 * Scrub secrets from a diagnostic message.
 * Applies scrubbing to message, stack_trace, and hints fields.
 */
export interface DiagnosticLike {
  message: string;
  stack_trace?: string;
  hints?: string[];
}

export const scrubDiagnostic = <T extends DiagnosticLike>(
  diagnostic: T
): T => ({
  ...diagnostic,
  message: scrubSecrets(diagnostic.message),
  stack_trace: diagnostic.stack_trace
    ? scrubSecrets(diagnostic.stack_trace)
    : undefined,
  hints: diagnostic.hints?.map(scrubSecrets),
});

/**
 * Scrub user home directory paths from file paths.
 *
 * Replaces usernames in common home directory patterns to prevent PII leakage.
 * @example "/Users/johndoe/project/src/app.ts" -> "/Users/[USER]/project/src/app.ts"
 */
export const scrubFilePath = (
  filePath: string | undefined
): string | undefined => {
  if (!filePath) {
    return filePath;
  }

  let result = filePath;

  // Scrub Unix home paths: /home/username -> /home/[USER]
  result = result.replace(UNIX_HOME_PATH_PATTERN, "/home/[USER]");

  // Scrub macOS home paths: /Users/username -> /Users/[USER]
  result = result.replace(MACOS_HOME_PATH_PATTERN, "/Users/[USER]");

  // Scrub Windows home paths: C:\Users\username -> C:\Users\[USER]
  result = result.replace(WINDOWS_HOME_PATH_PATTERN, "C:\\Users\\[USER]");

  // Scrub root paths: /root/... -> /[ROOT]/...
  result = result.replace(ROOT_PATH_PATTERN, "/[ROOT]");

  return result;
};
