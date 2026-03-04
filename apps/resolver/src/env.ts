export interface Env {
  PORT: string;
  /** Max concurrent resolves (default: 20). Set lower if Railway resources are constrained. */
  MAX_CONCURRENT_RESOLVES: number;
  SANDBOX_PROVIDER?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_TARGET?: string;
  DAYTONA_ORGANIZATION_ID?: string;
  DAYTONA_JWT_TOKEN?: string;
  E2B_API_KEY?: string;
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  VERCEL_PROJECT_ID?: string;
  AI_GATEWAY_API_KEY: string;
  DATABASE_URL: string;
  CONVEX_URL: string;
  CONVEX_SERVICE_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** Detent app base URL for resolve links, e.g., https://detent.sh */
  APP_BASE_URL: string;
  /** @deprecated Use APP_BASE_URL */
  NAVIGATOR_BASE_URL?: string;
  /** Public resolver queue webhook URL (as configured in Upstash QStash) */
  RESOLVER_WEBHOOK_URL?: string;
  /** Upstash QStash request signing keys (current + optional next for key rotation) */
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
  /** Upstash-compatible aliases for callback verification */
  UPSTASH_QSTASH_CURRENT_SIGNING_KEY?: string;
  UPSTASH_QSTASH_NEXT_SIGNING_KEY?: string;
  /** GitHub API retry config - max number of retry attempts (default: 2) */
  GITHUB_API_MAX_RETRIES: number;
  /** GitHub API retry config - initial delay in ms before first retry (default: 1000) */
  GITHUB_API_INITIAL_DELAY_MS: number;
  /** GitHub API retry config - backoff multiplier for subsequent retries (default: 2) */
  GITHUB_API_BACKOFF_MULTIPLIER: number;
  /** Base64-encoded AES-GCM key for decrypting webhook secrets */
  ENCRYPTION_KEY: string;
}

const validateRequired = (name: string, value: string | undefined): string => {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const parseIntWithDefault = (
  envVar: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseInt(envVar ?? String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const loadEnv = (): Env => {
  const sandboxProvider =
    process.env.SANDBOX_PROVIDER?.toLowerCase() ?? "daytona";
  const e2bApiKey = process.env.E2B_API_KEY;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  const vercelProjectId = process.env.VERCEL_PROJECT_ID;
  const daytonaApiKey = process.env.DAYTONA_API_KEY;
  const daytonaApiUrl = process.env.DAYTONA_API_URL;
  const daytonaTarget = process.env.DAYTONA_TARGET;
  const daytonaOrganizationId = process.env.DAYTONA_ORGANIZATION_ID;
  const daytonaJwtToken = process.env.DAYTONA_JWT_TOKEN;

  if (sandboxProvider === "daytona" && !(daytonaApiKey || daytonaJwtToken)) {
    throw new Error(
      "Sandbox provider 'daytona' requires DAYTONA_API_KEY or DAYTONA_JWT_TOKEN"
    );
  }

  if (sandboxProvider === "e2b") {
    validateRequired("E2B_API_KEY", e2bApiKey);
  }

  if (
    sandboxProvider === "vercel" &&
    !(vercelToken && vercelTeamId && vercelProjectId)
  ) {
    throw new Error(
      "Vercel sandbox auth requires VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID"
    );
  }

  const maxConcurrentResolves = parseIntWithDefault(
    process.env.MAX_CONCURRENT_RESOLVES,
    20
  );

  return {
    PORT: process.env.PORT ?? "8080",
    MAX_CONCURRENT_RESOLVES:
      maxConcurrentResolves < 1 ? 20 : Math.min(maxConcurrentResolves, 100),
    GITHUB_API_MAX_RETRIES: parseIntWithDefault(
      process.env.GITHUB_API_MAX_RETRIES,
      2
    ),
    GITHUB_API_INITIAL_DELAY_MS: parseIntWithDefault(
      process.env.GITHUB_API_INITIAL_DELAY_MS,
      1000
    ),
    GITHUB_API_BACKOFF_MULTIPLIER: parseIntWithDefault(
      process.env.GITHUB_API_BACKOFF_MULTIPLIER,
      2
    ),
    SANDBOX_PROVIDER: sandboxProvider,
    DAYTONA_API_KEY: daytonaApiKey,
    DAYTONA_API_URL: daytonaApiUrl,
    DAYTONA_TARGET: daytonaTarget,
    DAYTONA_ORGANIZATION_ID: daytonaOrganizationId,
    DAYTONA_JWT_TOKEN: daytonaJwtToken,
    E2B_API_KEY: e2bApiKey,
    VERCEL_TOKEN: vercelToken,
    VERCEL_TEAM_ID: vercelTeamId,
    VERCEL_PROJECT_ID: vercelProjectId,
    AI_GATEWAY_API_KEY: validateRequired(
      "AI_GATEWAY_API_KEY",
      process.env.AI_GATEWAY_API_KEY
    ),
    DATABASE_URL: validateRequired("DATABASE_URL", process.env.DATABASE_URL),
    CONVEX_URL: validateRequired("CONVEX_URL", process.env.CONVEX_URL),
    CONVEX_SERVICE_TOKEN: validateRequired(
      "CONVEX_SERVICE_TOKEN",
      process.env.CONVEX_SERVICE_TOKEN
    ),
    GITHUB_APP_ID: validateRequired("GITHUB_APP_ID", process.env.GITHUB_APP_ID),
    GITHUB_APP_PRIVATE_KEY: validateRequired(
      "GITHUB_APP_PRIVATE_KEY",
      process.env.GITHUB_APP_PRIVATE_KEY
    ),
    APP_BASE_URL:
      process.env.APP_BASE_URL ??
      process.env.NAVIGATOR_BASE_URL ??
      "https://detent.sh",
    NAVIGATOR_BASE_URL: process.env.NAVIGATOR_BASE_URL,
    RESOLVER_WEBHOOK_URL: process.env.RESOLVER_WEBHOOK_URL,
    QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY,
    QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY,
    UPSTASH_QSTASH_CURRENT_SIGNING_KEY:
      process.env.UPSTASH_QSTASH_CURRENT_SIGNING_KEY,
    UPSTASH_QSTASH_NEXT_SIGNING_KEY:
      process.env.UPSTASH_QSTASH_NEXT_SIGNING_KEY,
    ENCRYPTION_KEY: validateRequired(
      "ENCRYPTION_KEY",
      process.env.ENCRYPTION_KEY
    ),
  };
};

export const env: Env = loadEnv();
