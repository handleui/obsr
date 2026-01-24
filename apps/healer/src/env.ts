export interface Env {
  PORT: string;
  E2B_API_KEY: string;
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

const loadEnv = (): Env => ({
  PORT: process.env.PORT ?? "8080",
  E2B_API_KEY: validateRequired("E2B_API_KEY", process.env.E2B_API_KEY),
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
});

export const env: Env = loadEnv();
