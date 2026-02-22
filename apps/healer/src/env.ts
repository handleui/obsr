export interface Env {
  PORT: string;
  /** Max concurrent heals (default: 20). Set lower if Railway resources are constrained. */
  MAX_CONCURRENT_HEALS: number;
  SANDBOX_PROVIDER?: string;
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
  /** Navigator (web app) base URL for dashboard links, e.g., https://navigator.detent.sh */
  NAVIGATOR_BASE_URL: string;
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
    process.env.SANDBOX_PROVIDER?.toLowerCase() ?? "vercel";
  const e2bApiKey = process.env.E2B_API_KEY;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  const vercelProjectId = process.env.VERCEL_PROJECT_ID;

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

  const maxConcurrentHeals = parseIntWithDefault(
    process.env.MAX_CONCURRENT_HEALS,
    20
  );

  return {
    PORT: process.env.PORT ?? "8080",
    MAX_CONCURRENT_HEALS:
      maxConcurrentHeals < 1 ? 20 : Math.min(maxConcurrentHeals, 100),
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
    NAVIGATOR_BASE_URL:
      process.env.NAVIGATOR_BASE_URL ?? "https://navigator.detent.sh",
    ENCRYPTION_KEY: validateRequired(
      "ENCRYPTION_KEY",
      process.env.ENCRYPTION_KEY
    ),
  };
};

export const env: Env = loadEnv();
