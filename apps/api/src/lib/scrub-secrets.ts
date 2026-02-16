const TOKEN_PATTERNS = [
  /gh[porsu]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /Bearer\s+[A-Za-z0-9._\-/+=]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  /vercel_[A-Za-z0-9_]{32,}/gi,
  /dtk_[A-Za-z0-9_-]{32}/g,

  /(?:glpat-[A-Za-z0-9_-]{20,}|[spr]k_(?:live|test)_[A-Za-z0-9]{20,}|sk-ant-(?:api03-|admin-)[A-Za-z0-9_-]{32,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|re_[A-Za-z0-9_]{32,}|sbp_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,

  /(?:[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|[?&]sig=[A-Za-z0-9%+/=]{20,}|(?:SK|AC)[0-9a-fA-F]{32}|hv[sbp]\.[A-Za-z0-9_-]{20,}|dp\.[a-z]{2,4}\.[A-Za-z0-9]{20,}|dapi[a-f0-9]{32}|shp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32,}|glsa_[A-Za-z0-9_]{32,}|CONFLUENT_[A-Za-z0-9]{16,})/g,

  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----[\s\S]{1,16384}?-----END\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g,
  // HACK: only match base64 after assignment operator to avoid false positives on images/source maps — capped at 512 chars to prevent catastrophic backtracking
  /(?<=[=:]\s*['"]?)[A-Za-z0-9+/]{40,512}={0,2}(?=['"]?\s*(?:[,}\]\n\r]|$))/g,
];

const ENV_VAR_PATTERN =
  /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|MASTER_?KEY|PASSPHRASE|DSN|CLIENT_?SECRET|WEBHOOK_?SECRET|DATABASE_?URL|SMTP_?PASSWORD|REDIS_?PASSWORD|MONGO_?URI|SESSION_?SECRET|APP_?SECRET)\w{0,64}\s{0,8}[=:]\s{0,8}['"]?[^\s'"]{8,512}['"]?/gi;

const CONNECTION_STRING_PATTERN =
  /(?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?|nats|kafka|cockroachdb):\/\/[^:]{1,256}:[^@]{1,256}@[^\s"']{1,1024}/gi;

const ENV_VAR_SEPARATOR_PATTERN = /[=:]/;

const UNIX_HOME_PATH_PATTERN = /\/home\/([^/\s]+)/g;
const MACOS_HOME_PATH_PATTERN = /\/Users\/([^/\s]+)/g;
const WINDOWS_HOME_PATH_PATTERN = /C:\\Users\\([^\\\s]+)/gi;
const ROOT_PATH_PATTERN = /\/root(?=\/)/g;

const MAX_SCRUB_LENGTH = 5 * 1024 * 1024;

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

const redactTokens = (input: string): string => {
  let result = input;
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  ENV_VAR_PATTERN.lastIndex = 0;
  result = result.replace(ENV_VAR_PATTERN, redactEnvVar);
  CONNECTION_STRING_PATTERN.lastIndex = 0;
  return result.replace(CONNECTION_STRING_PATTERN, redactConnectionString);
};

export const scrubSecrets = (value: string): string => {
  if (value.length === 0) {
    return value;
  }

  const wasTruncated = value.length > MAX_SCRUB_LENGTH;
  const input = wasTruncated ? value.slice(0, MAX_SCRUB_LENGTH) : value;
  const result = redactTokens(input);

  if (!wasTruncated) {
    return result;
  }

  return `${result}\n[SCRUB_TRUNCATED — content beyond ${MAX_SCRUB_LENGTH / 1024 / 1024}MB was dropped unscrubbed]`;
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
