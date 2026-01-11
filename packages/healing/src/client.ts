import { generateText } from "ai";

/**
 * Default per-request timeout for API calls (30 seconds).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Normalizes model IDs for the AI Gateway.
 * Adds a provider prefix for legacy Claude model names.
 */
const normalizeModelId = (model: string): string => {
  if (model.includes("/")) {
    return model;
  }
  if (model.startsWith("claude-")) {
    return `anthropic/${model}`;
  }
  return model;
};

/**
 * Client wraps AI Gateway access for healing operations.
 */
export class Client {
  private readonly byokAnthropicApiKey?: string;

  constructor(apiKey?: string, options?: { anthropicApiKey?: string }) {
    const resolvedKey = apiKey ?? process.env.AI_GATEWAY_API_KEY ?? "";
    if (!resolvedKey) {
      throw new Error("No API key provided");
    }

    if (!process.env.AI_GATEWAY_API_KEY) {
      process.env.AI_GATEWAY_API_KEY = resolvedKey;
    }

    const byokKey = options?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (byokKey) {
      this.byokAnthropicApiKey = byokKey;
    }
  }

  /**
   * Normalizes a model ID for the AI Gateway.
   */
  normalizeModel = (model: string): string => normalizeModelId(model);

  /**
   * Returns provider options for request-scoped BYOK, if configured.
   */
  providerOptions = (
    model: string
  ): {
    gateway: {
      byok: {
        anthropic: Array<{
          apiKey: string;
        }>;
      };
    };
  } | null => {
    if (!this.byokAnthropicApiKey) {
      return null;
    }

    const normalized = normalizeModelId(model);
    if (!normalized.startsWith("anthropic/")) {
      return null;
    }

    return {
      gateway: {
        byok: {
          anthropic: [{ apiKey: this.byokAnthropicApiKey }],
        },
      },
    };
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
        model: normalizeModelId("claude-3-5-haiku-latest"),
        maxOutputTokens: 100,
        prompt: "Say 'Hello from the AI Gateway!' in exactly 5 words.",
        abortSignal: abortController.signal,
        providerOptions:
          this.providerOptions("claude-3-5-haiku-latest") ?? undefined,
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
