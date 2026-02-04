import type {
  JSONValue,
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
} from "ai";

export type CacheTTL = "5m" | "1h";

type JSONRecord = Record<string, JSONValue>;

interface CacheControlValue {
  type: "ephemeral";
  ttl?: CacheTTL;
}

interface AnthropicProviderValue {
  cacheControl: CacheControlValue;
}

export type AnthropicCacheOptions = {
  anthropic: AnthropicProviderValue;
} & JSONRecord;

const DEFAULT_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

const CACHE_CONTROL_BY_TTL: Record<CacheTTL, AnthropicCacheOptions> = {
  "5m": { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
  "1h": { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
};

export const isAnthropicModel = (model: LanguageModel): boolean => {
  if (typeof model === "string") {
    return (
      model.includes("anthropic") ||
      model.includes("claude") ||
      model.startsWith("claude-")
    );
  }
  const provider = model.provider ?? "";
  const modelId = model.modelId ?? "";
  return (
    provider.includes("anthropic") ||
    modelId.includes("claude") ||
    modelId.includes("anthropic")
  );
};

export interface AddCacheControlOptions {
  messages: ModelMessage[];
  model: LanguageModel;
  ttl?: CacheTTL;
}

export const addCacheControl = ({
  messages,
  model,
  ttl,
}: AddCacheControlOptions): ModelMessage[] => {
  if (messages.length === 0) {
    return messages;
  }
  if (!isAnthropicModel(model)) {
    return messages;
  }

  const cacheOptions = ttl ? CACHE_CONTROL_BY_TTL[ttl] : DEFAULT_CACHE_CONTROL;

  return messages.map((message, index) => {
    if (index === messages.length - 1) {
      const existing = (
        message as { providerOptions?: Record<string, unknown> }
      ).providerOptions;
      return {
        ...message,
        providerOptions: {
          ...existing,
          ...cacheOptions,
        },
      } as ModelMessage;
    }
    return message;
  });
};

export const createCacheableSystemMessage = (
  content: string,
  ttl?: CacheTTL
): SystemModelMessage => {
  const cacheControl: CacheControlValue = ttl
    ? { type: "ephemeral", ttl }
    : { type: "ephemeral" };

  return {
    role: "system",
    content,
    providerOptions: {
      anthropic: { cacheControl },
    },
  } as unknown as SystemModelMessage;
};

export interface PrepareStepParams {
  steps: unknown[];
  stepNumber: number;
  model: LanguageModel;
  messages: ModelMessage[];
  experimental_context?: unknown;
}

export const createCachePrepareStep = (
  ttl?: CacheTTL
): ((
  params: PrepareStepParams
) => { messages: ModelMessage[] } | undefined) => {
  return ({ messages, model }) => ({
    messages: addCacheControl({ messages, model, ttl }),
  });
};
