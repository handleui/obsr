import type {
  JSONValue,
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
} from "ai";

export type CacheTTL = "5m" | "1h";

/**
 * Provider options type - matches the AI SDK's ProviderOptions type.
 * Defined locally to avoid importing from @ai-sdk/provider which has version conflicts.
 */
type ProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * Internal type for cache control that we use for type safety within this module.
 * At runtime, this is serialized to JSON and the optional `ttl` becomes absent if undefined.
 */
interface InternalCacheControl {
  type: "ephemeral";
  ttl?: CacheTTL;
}

/**
 * Internal type for Anthropic provider options used within this module.
 */
interface InternalAnthropicOptions {
  anthropic: {
    cacheControl: InternalCacheControl;
  };
}

/**
 * Anthropic-specific provider options for cache control.
 * Exported as ProviderOptions for API compatibility.
 */
export type AnthropicCacheOptions = ProviderOptions;

/**
 * Creates cache control options that are compatible with ProviderOptions.
 * Uses a type assertion at the boundary to convert our well-typed internal structure.
 */
const createCacheOptions = (ttl?: CacheTTL): ProviderOptions => {
  const internal: InternalAnthropicOptions = {
    anthropic: {
      cacheControl: ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" },
    },
  };
  // Cast at the boundary: our internal structure is JSON-serializable and compatible
  return internal as unknown as ProviderOptions;
};

const DEFAULT_CACHE_CONTROL = createCacheOptions();

const CACHE_CONTROL_BY_TTL: Record<CacheTTL, ProviderOptions> = {
  "5m": createCacheOptions("5m"),
  "1h": createCacheOptions("1h"),
};

/**
 * Gets cache options for the given TTL.
 */
const getCacheOptions = (ttl?: CacheTTL): ProviderOptions =>
  ttl ? CACHE_CONTROL_BY_TTL[ttl] : DEFAULT_CACHE_CONTROL;

/**
 * Type guard to check if providerOptions contains an Anthropic section.
 */
const hasAnthropicProvider = (
  options: ProviderOptions | undefined
): options is ProviderOptions & { anthropic: Record<string, JSONValue> } =>
  options !== undefined &&
  typeof options === "object" &&
  "anthropic" in options &&
  typeof options.anthropic === "object" &&
  options.anthropic !== null;

/**
 * Merges provider options, preserving existing options while adding new ones.
 */
const mergeProviderOptions = (
  existing: ProviderOptions | undefined,
  additional: ProviderOptions
): ProviderOptions => {
  if (!existing) {
    return additional;
  }

  if (hasAnthropicProvider(existing) && hasAnthropicProvider(additional)) {
    return {
      ...existing,
      anthropic: {
        ...existing.anthropic,
        ...additional.anthropic,
      },
    };
  }

  return {
    ...existing,
    ...additional,
  };
};

export const isAnthropicModel = (model: LanguageModel): boolean => {
  // LanguageModel can be a string literal (model ID) or an object with provider/modelId
  if (typeof model === "string") {
    return (
      model.includes("anthropic") ||
      model.includes("claude") ||
      model.startsWith("claude-")
    );
  }

  // Cast to object type - at runtime, non-string models have provider/modelId
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

/**
 * Adds cache control provider options to a message while preserving its type.
 * Uses a switch statement to ensure TypeScript can narrow the discriminated union
 * and properly type the returned message.
 */
const addProviderOptionsToMessage = (
  message: ModelMessage,
  cacheOptions: ProviderOptions
): ModelMessage => {
  const merged = mergeProviderOptions(message.providerOptions, cacheOptions);

  switch (message.role) {
    case "system":
      return { ...message, providerOptions: merged };
    case "user":
      return { ...message, providerOptions: merged };
    case "assistant":
      return { ...message, providerOptions: merged };
    case "tool":
      return { ...message, providerOptions: merged };
    default:
      // Exhaustive check - this should never be reached if ModelMessage union is complete
      return message;
  }
};

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

  return messages.map((message, index) => {
    // Anthropic caches from the last cache-control marker, so only mark the final message
    if (index === messages.length - 1) {
      return addProviderOptionsToMessage(message, cacheOptions);
    }
    return message;
  });
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
