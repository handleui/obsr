const TOKEN_PATTERNS = [
  /gh[porsu]_[A-Za-z0-9_]{36,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub PATs
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PATs
  /Bearer\s+[A-Za-z0-9._\-/+=]{20,}/gi, // Bearer tokens
  /[spr]k_(?:live|test)_[A-Za-z0-9]{20,}/g, // Stripe keys
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /re_[A-Za-z0-9_]{32,}/g, // Resend keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS access keys
  /sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{32,}/g, // OpenAI keys
  /sk-ant-(?:api03-|admin-)[A-Za-z0-9_-]{32,}/g, // Anthropic keys
  /vercel_[A-Za-z0-9_]{32,}/gi, // Vercel tokens
  /npm_[A-Za-z0-9]{36,}/g, // npm tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord tokens
  /dtk_[A-Za-z0-9_-]{32}/g, // Detent API keys
  /AIza[A-Za-z0-9_-]{35}/g, // Google Cloud API keys
  /ya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth tokens
  /[?&]sig=[A-Za-z0-9%+/=]{20,}/g, // Azure SAS tokens
  /sbp_[A-Za-z0-9]{20,}/g, // Supabase keys
  /SK[0-9a-fA-F]{32}/g, // Twilio API keys
  /AC[0-9a-fA-F]{32}/g, // Twilio Account SIDs
  /SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // SendGrid API keys
  /hv[sbp]\.[A-Za-z0-9_-]{20,}/g, // Hashicorp Vault tokens
  /dp\.[a-z]{2,4}\.[A-Za-z0-9]{20,}/g, // Doppler tokens
  /dapi[a-f0-9]{32}/g, // Databricks PATs
  /shp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32,}/g, // Shopify tokens
  /glsa_[A-Za-z0-9_]{32,}/g, // Grafana tokens
  /CONFLUENT_[A-Za-z0-9]{16,}/g, // Confluent Cloud keys
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g, // PEM private keys
  // HACK: only match base64 after assignment operator to avoid false positives on images/source maps
  /(?<=[=:]\s*['"]?)[A-Za-z0-9+/]{40,}={0,2}(?=['"]?\s*(?:[,}\]\n\r]|$))/g,
];

const ENV_VAR_PATTERN =
  /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY)[\w]*\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi;

const CONNECTION_STRING_PATTERN =
  /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^:]+:[^@]+@[^\s"']+/gi;

const ENV_VAR_SEPARATOR_PATTERN = /[=:]/;

const UNIX_HOME_PATH_PATTERN = /\/home\/([^/\s]+)/g;
const MACOS_HOME_PATH_PATTERN = /\/Users\/([^/\s]+)/g;
const WINDOWS_HOME_PATH_PATTERN = /C:\\Users\\([^\\\s]+)/gi;
const ROOT_PATH_PATTERN = /\/root(?=\/)/g;

export const scrubSecrets = (value: string): string => {
  let result = value;

  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }

  result = result.replace(ENV_VAR_PATTERN, (match) => {
    const eqIndex = match.search(ENV_VAR_SEPARATOR_PATTERN);
    if (eqIndex !== -1) {
      return `${match.slice(0, eqIndex + 1)}[REDACTED]`;
    }
    return "[REDACTED]";
  });

  result = result.replace(CONNECTION_STRING_PATTERN, (match) => {
    const atIndex = match.lastIndexOf("@");
    const protocolEnd = match.indexOf("://") + 3;
    if (atIndex !== -1 && protocolEnd > 3) {
      return `${match.slice(0, protocolEnd)}[REDACTED]@${match.slice(atIndex + 1)}`;
    }
    return "[REDACTED]";
  });

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

  return filePath
    .replace(UNIX_HOME_PATH_PATTERN, "/home/[USER]")
    .replace(MACOS_HOME_PATH_PATTERN, "/Users/[USER]")
    .replace(WINDOWS_HOME_PATH_PATTERN, "C:\\Users\\[USER]")
    .replace(ROOT_PATH_PATTERN, "/[ROOT]");
};
