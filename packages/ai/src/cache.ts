import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type {
  JSONValue,
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
} from "ai";

export type CacheTTL = "5m" | "1h";

type ProviderOptions = SharedV3ProviderOptions;

interface InternalCacheControl {
  type: "ephemeral";
  ttl?: CacheTTL;
}

interface InternalAnthropicOptions {
  anthropic: {
    cacheControl: InternalCacheControl;
  };
}

export type AnthropicCacheOptions = ProviderOptions;

const createCacheOptions = (ttl?: CacheTTL): ProviderOptions => {
  if (ttl && ttl !== "5m" && ttl !== "1h") {
    throw new Error(`Invalid cache TTL: ${ttl}. Must be "5m" or "1h".`);
  }

  const cacheControl: InternalCacheControl = ttl
    ? { type: "ephemeral", ttl }
    : { type: "ephemeral" };

  const internal: InternalAnthropicOptions = {
    anthropic: { cacheControl },
  };
  return internal as unknown as ProviderOptions;
};

const DEFAULT_CACHE_CONTROL = createCacheOptions();

const CACHE_CONTROL_BY_TTL: Record<CacheTTL, ProviderOptions> = {
  "5m": createCacheOptions("5m"),
  "1h": createCacheOptions("1h"),
};

const getCacheOptions = (ttl?: CacheTTL): ProviderOptions =>
  ttl ? CACHE_CONTROL_BY_TTL[ttl] : DEFAULT_CACHE_CONTROL;

const hasAnthropicProvider = (
  options: ProviderOptions | undefined
): options is ProviderOptions & {
  anthropic: Record<string, JSONValue | undefined>;
} =>
  options !== undefined &&
  typeof options === "object" &&
  "anthropic" in options &&
  typeof options.anthropic === "object" &&
  options.anthropic !== null;

const mergeProviderOptions = (
  existing: ProviderOptions | undefined,
  additional: ProviderOptions
): ProviderOptions => {
  if (!existing) {
    return additional;
  }

  const hasAnthropicInBoth =
    hasAnthropicProvider(existing) && hasAnthropicProvider(additional);

  if (hasAnthropicInBoth) {
    return {
      ...existing,
      anthropic: {
        ...existing.anthropic,
        ...additional.anthropic,
      },
    };
  }

  return { ...existing, ...additional };
};

export const isAnthropicModel = (model: LanguageModel): boolean => {
  if (typeof model === "string") {
    return model.includes("anthropic") || model.includes("claude");
  }

  const modelObj = model as { provider?: string; modelId?: string };
  const provider = modelObj.provider ?? "";
  const modelId = modelObj.modelId ?? "";
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

const addProviderOptionsToMessage = (
  message: ModelMessage,
  cacheOptions: ProviderOptions
): ModelMessage => ({
  ...message,
  providerOptions: mergeProviderOptions(message.providerOptions, cacheOptions),
});

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

  const cacheOptions = getCacheOptions(ttl);
  const lastIndex = messages.length - 1;

  return messages.map((message, index) =>
    index === lastIndex
      ? addProviderOptionsToMessage(message, cacheOptions)
      : message
  );
};

export const createCacheableSystemMessage = (
  content: string,
  ttl?: CacheTTL
): SystemModelMessage => {
  const cacheOptions = getCacheOptions(ttl);

  return {
    role: "system",
    content,
    providerOptions: cacheOptions,
  };
};

export interface PrepareStepParams {
  steps: unknown[];
  stepNumber: number;
  model: LanguageModel;
  messages: ModelMessage[];
  experimental_context: unknown;
}

export const createCachePrepareStep =
  (
    ttl?: CacheTTL
  ): ((
    params: PrepareStepParams
  ) => { messages: ModelMessage[] } | undefined) =>
  ({ messages, model }) => ({
    messages: addCacheControl({ messages, model, ttl }),
  });
