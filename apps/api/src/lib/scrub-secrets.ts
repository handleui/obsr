// Ordered by likelihood in CI logs: common CI/CD tokens first, rare provider
// tokens last, and expensive patterns (variable-length lookbehind, lazy [\s\S])
// at the very end so cheap literal-prefix patterns short-circuit early.
const TOKEN_PATTERNS = [
  // --- High frequency in CI logs ---
  /gh[porsu]_[A-Za-z0-9_]{36,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub PATs
  /Bearer\s+[A-Za-z0-9._\-/+=]{20,}/gi, // Bearer tokens
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS access keys
  /npm_[A-Za-z0-9]{36,}/g, // npm tokens
  /sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{32,}/g, // OpenAI keys
  /vercel_[A-Za-z0-9_]{32,}/gi, // Vercel tokens
  /dtk_[A-Za-z0-9_-]{32}/g, // Detent API keys

  // --- Medium frequency (single alternation = 1 pass instead of 9) ---
  /(?:glpat-[A-Za-z0-9_-]{20,}|[spr]k_(?:live|test)_[A-Za-z0-9]{20,}|sk-ant-(?:api03-|admin-)[A-Za-z0-9_-]{32,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|re_[A-Za-z0-9_]{32,}|sbp_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,

  // --- Low frequency (single alternation = 1 pass instead of 10) ---
  /(?:[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|[?&]sig=[A-Za-z0-9%+/=]{20,}|(?:SK|AC)[0-9a-fA-F]{32}|hv[sbp]\.[A-Za-z0-9_-]{20,}|dp\.[a-z]{2,4}\.[A-Za-z0-9]{20,}|dapi[a-f0-9]{32}|shp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32,}|glsa_[A-Za-z0-9_]{32,}|CONFLUENT_[A-Za-z0-9]{16,})/g,

  // --- Expensive patterns (run last) ---
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----[\s\S]{1,16384}?-----END\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g, // PEM private keys (bounded to 16KB to prevent backtracking on large logs)
  // HACK: only match base64 after assignment operator to avoid false positives on images/source maps
  // Capped at 512 chars to prevent catastrophic backtracking on large base64 blobs (e.g. source maps)
  /(?<=[=:]\s*['"]?)[A-Za-z0-9+/]{40,512}={0,2}(?=['"]?\s*(?:[,}\]\n\r]|$))/g,
];

// Bounded \w{0,64} and \s{0,8} prevent backtracking when a keyword appears in
// a long word-character run that never reaches `=` or `:`.
const ENV_VAR_PATTERN =
  /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|MASTER_?KEY|PASSPHRASE|DSN|CLIENT_?SECRET|WEBHOOK_?SECRET|DATABASE_?URL|SMTP_?PASSWORD|REDIS_?PASSWORD|MONGO_?URI|SESSION_?SECRET|APP_?SECRET)\w{0,64}\s{0,8}[=:]\s{0,8}['"]?[^\s'"]{8,512}['"]?/gi;

const CONNECTION_STRING_PATTERN =
  /(?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?|nats|kafka|cockroachdb):\/\/[^:]{1,256}:[^@]{1,256}@[^\s"']{1,1024}/gi;

const ENV_VAR_SEPARATOR_PATTERN = /[=:]/;

const UNIX_HOME_PATH_PATTERN = /\/home\/([^/\s]+)/g;
const MACOS_HOME_PATH_PATTERN = /\/Users\/([^/\s]+)/g;
const WINDOWS_HOME_PATH_PATTERN = /C:\\Users\\([^\\\s]+)/gi;
const ROOT_PATH_PATTERN = /\/root(?=\/)/g;

// Hard ceiling to prevent CPU exhaustion if called from an unguarded path.
// Callers should pre-slice, but this is a safety net.
const MAX_SCRUB_LENGTH = 5 * 1024 * 1024; // 5 MB

const redactEnvVar = (match: string): string => {
  const eqIndex = match.search(ENV_VAR_SEPARATOR_PATTERN);
  if (eqIndex !== -1) {
    return `${match.slice(0, eqIndex + 1)}[REDACTED]`;
  }
  return "[REDACTED]";
};

const redactConnectionString = (match: string): string => {
  const atIndex = match.lastIndexOf("@");
  const protocolEnd = match.indexOf("://") + 3;
  if (atIndex !== -1 && protocolEnd > 3) {
    return `${match.slice(0, protocolEnd)}[REDACTED]@${match.slice(atIndex + 1)}`;
  }
  return "[REDACTED]";
};

export const scrubSecrets = (value: string): string => {
  if (value.length === 0) {
    return value;
  }

  const wasTruncated = value.length > MAX_SCRUB_LENGTH;
  let result = wasTruncated ? value.slice(0, MAX_SCRUB_LENGTH) : value;

  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }

  ENV_VAR_PATTERN.lastIndex = 0;
  result = result.replace(ENV_VAR_PATTERN, redactEnvVar);
  CONNECTION_STRING_PATTERN.lastIndex = 0;
  result = result.replace(CONNECTION_STRING_PATTERN, redactConnectionString);

  if (wasTruncated) {
    result += `\n[SCRUB_TRUNCATED — content beyond ${MAX_SCRUB_LENGTH / 1024 / 1024}MB was dropped unscrubbed]`;
  }

  return result;
};

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

export const scrubFilePath = (
  filePath: string | undefined
): string | undefined => {
  if (!filePath) {
    return filePath;
  }

  UNIX_HOME_PATH_PATTERN.lastIndex = 0;
  MACOS_HOME_PATH_PATTERN.lastIndex = 0;
  WINDOWS_HOME_PATH_PATTERN.lastIndex = 0;
  ROOT_PATH_PATTERN.lastIndex = 0;

  return filePath
    .replace(UNIX_HOME_PATH_PATTERN, "/home/[USER]")
    .replace(MACOS_HOME_PATH_PATTERN, "/Users/[USER]")
    .replace(WINDOWS_HOME_PATH_PATTERN, "C:\\Users\\[USER]")
    .replace(ROOT_PATH_PATTERN, "/[ROOT]");
};
