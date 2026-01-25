export interface Env {
  PORT: string;
  SANDBOX_PROVIDER?: string;
  E2B_API_KEY?: string;
  VERCEL_OIDC_TOKEN?: string;
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  VERCEL_PROJECT_ID?: string;
  AI_GATEWAY_API_KEY: string;
  DATABASE_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

const validateRequired = (name: string, value: string | undefined): string => {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const loadEnv = (): Env => {
  const sandboxProvider =
    process.env.SANDBOX_PROVIDER?.toLowerCase() ?? "vercel";
  const e2bApiKey = process.env.E2B_API_KEY;
  const vercelOidcToken = process.env.VERCEL_OIDC_TOKEN;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  const vercelProjectId = process.env.VERCEL_PROJECT_ID;

  if (sandboxProvider === "e2b") {
    validateRequired("E2B_API_KEY", e2bApiKey);
  }

  if (
    sandboxProvider === "vercel" &&
    !(vercelOidcToken || (vercelToken && vercelTeamId && vercelProjectId))
  ) {
    throw new Error(
      "Vercel sandbox auth requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID"
    );
  }

  return {
    PORT: process.env.PORT ?? "8080",
    SANDBOX_PROVIDER: sandboxProvider,
    E2B_API_KEY: e2bApiKey,
    VERCEL_OIDC_TOKEN: vercelOidcToken,
    VERCEL_TOKEN: vercelToken,
    VERCEL_TEAM_ID: vercelTeamId,
    VERCEL_PROJECT_ID: vercelProjectId,
    AI_GATEWAY_API_KEY: validateRequired(
      "AI_GATEWAY_API_KEY",
      process.env.AI_GATEWAY_API_KEY
    ),
    DATABASE_URL: validateRequired("DATABASE_URL", process.env.DATABASE_URL),
    GITHUB_APP_ID: validateRequired("GITHUB_APP_ID", process.env.GITHUB_APP_ID),
    GITHUB_APP_PRIVATE_KEY: validateRequired(
      "GITHUB_APP_PRIVATE_KEY",
      process.env.GITHUB_APP_PRIVATE_KEY
    ),
  };
};

export const env: Env = loadEnv();
