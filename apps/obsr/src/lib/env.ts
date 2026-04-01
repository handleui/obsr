const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const getObsrDatabaseUrl = () => {
  return requireEnv("OBSR_DATABASE_URL");
};

export const getAiGatewayApiKey = () => {
  return requireEnv("AI_GATEWAY_API_KEY");
};
