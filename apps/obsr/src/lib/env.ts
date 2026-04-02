const getOptionalEnv = (key: string) => {
  const value = process.env[key];
  if (!value?.trim()) {
    return undefined;
  }
  return value;
};

const requireEnv = (key: string) => {
  const value = getOptionalEnv(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const getObsrDatabaseUrl = () => {
  const databaseUrl =
    getOptionalEnv("DATABASE_URL") ?? getOptionalEnv("OBSR_DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL or OBSR_DATABASE_URL"
    );
  }
  return databaseUrl;
};

export const getDirectDatabaseUrl = () => {
  return getOptionalEnv("DIRECT_URL") ?? getObsrDatabaseUrl();
};

export const getAiGatewayApiKey = () => {
  return requireEnv("AI_GATEWAY_API_KEY");
};
