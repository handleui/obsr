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

export interface ResponsesApiConfig {
  apiKey: string;
  baseURL?: string;
  routingMode: "openai" | "gateway";
}

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

export const getResponsesApiConfig = (): ResponsesApiConfig => {
  const openAiApiKey =
    getOptionalEnv("OPENAI_API_KEY") ?? getOptionalEnv("OBSR_OPENAI_API_KEY");
  if (openAiApiKey) {
    return {
      apiKey: openAiApiKey,
      baseURL:
        getOptionalEnv("OPENAI_BASE_URL") ??
        getOptionalEnv("OBSR_OPENAI_BASE_URL"),
      routingMode: "openai",
    };
  }

  const gatewayApiKey = getOptionalEnv("AI_GATEWAY_API_KEY");
  if (!gatewayApiKey) {
    throw new Error(
      "Missing required environment variable: OPENAI_API_KEY or AI_GATEWAY_API_KEY"
    );
  }

  return {
    apiKey: gatewayApiKey,
    baseURL:
      getOptionalEnv("AI_GATEWAY_BASE_URL") ??
      getOptionalEnv("OBSR_AI_GATEWAY_BASE_URL") ??
      "https://ai-gateway.vercel.sh/v1",
    routingMode: "gateway",
  };
};

export const getEncryptionKey = () => {
  return requireEnv("OBSR_ENCRYPTION_KEY");
};
