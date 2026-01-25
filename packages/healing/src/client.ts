import { generateText } from "ai";

/**
 * Default per-request timeout for API calls (30 seconds).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Normalizes model IDs for the AI Gateway.
 * Adds a provider prefix for unqualified model names.
 */
const normalizeModelId = (model: string): string => {
  if (model.includes("/")) {
    return model;
  }
  if (model.startsWith("gpt-")) {
    return `openai/${model}`;
  }
  return model;
};

/**
 * Client wraps AI Gateway access for healing operations.
 */
export class Client {
  /**
   * Creates a new Client instance.
   *
   * Note: The AI Gateway reads AI_GATEWAY_API_KEY at module load time.
   * Only one Client instance with a given API key should be used per process.
   * Creating multiple instances with different keys will use the first key set.
   */
  constructor(apiKey?: string) {
    const resolvedKey = apiKey ?? process.env.AI_GATEWAY_API_KEY ?? "";
    if (!resolvedKey) {
      throw new Error("No API key provided");
    }

    // Always set the env var - the AI SDK reads it at provider creation time.
    // Warning: Multiple Client instances with different keys are not supported.
    process.env.AI_GATEWAY_API_KEY = resolvedKey;
  }

  /**
   * Normalizes a model ID for the AI Gateway.
   */
  normalizeModel = (model: string): string => normalizeModelId(model);

  /**
   * Returns provider options for request-scoped BYOK, if configured.
   */
  providerOptions = (_model: string): null => {
    return null;
  };

  /**
   * Tests the API connection by sending a simple request.
   * Uses Haiku for cost efficiency.
   */
  test = async (): Promise<string> => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS
    );

    try {
      const response = await generateText({
        model: normalizeModelId("gpt-5.2-codex"),
        maxOutputTokens: 100,
        prompt: "Say 'Hello from the AI Gateway!' in exactly 5 words.",
        abortSignal: abortController.signal,
      });

      if (response.text) {
        return response.text;
      }

      throw new Error("No text response from model");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("API request timed out");
      }
      throw this.formatAPIError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  /**
   * Provides user-friendly error messages for AI Gateway errors.
   */
  private readonly formatAPIError = (error: unknown): Error => {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: number }).status
        : undefined;

    if (typeof status === "number") {
      switch (status) {
        case 401:
          return new Error(
            "Invalid API key: check AI_GATEWAY_API_KEY or ~/.detent/config.jsonc"
          );
        case 403:
          return new Error("API key lacks permission for the requested model");
        case 429:
          return new Error("Rate limited: too many requests, try again later");
        case 500:
        case 502:
        case 503:
          return new Error(
            `AI Gateway unavailable (status ${status}): try again later`
          );
        default:
          return new Error(`API error (status ${status})`);
      }
    }

    if (error instanceof Error) {
      return new Error(`API request failed: ${error.message}`);
    }

    return new Error("API request failed: unknown error");
  };
}
