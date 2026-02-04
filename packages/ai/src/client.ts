import { generateObject, generateText } from "ai";
import type { Schema } from "zod";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
} from "./types.js";

/**
 * Default per-request timeout for API calls (30 seconds).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Normalizes model IDs for the AI Gateway.
 * Adds a provider prefix for unqualified model names.
 */
export const normalizeModelId = (model: string): string => {
  if (model.includes("/")) {
    return model;
  }
  if (model.startsWith("gpt-")) {
    return `openai/${model}`;
  }
  if (model.startsWith("claude-")) {
    return `anthropic/${model}`;
  }
  return model;
};

/**
 * Options for text generation.
 */
export interface GenerateTextOptions {
  /** Model to use */
  model?: string;
  /** System prompt */
  system?: string;
  /** User prompt */
  prompt: string;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

/**
 * Options for structured object generation.
 */
export interface GenerateObjectOptions<T> {
  /** Model to use */
  model?: string;
  /** Zod schema for the output */
  schema: Schema<T>;
  /** System prompt */
  system?: string;
  /** User prompt */
  prompt: string;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

/**
 * Result of text generation.
 */
export interface TextResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Result of object generation.
 */
export interface ObjectResult<T> {
  object: T;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * AI Engine client for text and structured output generation.
 */
export class AIClient {
  constructor(apiKey?: string) {
    const resolvedKey = apiKey ?? process.env.AI_GATEWAY_API_KEY ?? "";
    if (!resolvedKey) {
      throw new Error(
        "No API key provided. Set AI_GATEWAY_API_KEY or pass apiKey to constructor."
      );
    }
    // AI SDK reads this at provider creation time
    process.env.AI_GATEWAY_API_KEY = resolvedKey;
  }

  /**
   * Generates text from a prompt.
   */
  async text(options: GenerateTextOptions): Promise<TextResult> {
    const model = normalizeModelId(options.model ?? DEFAULT_FAST_MODEL);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxOutputTokens =
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      const response = await generateText({
        model,
        system: options.system,
        prompt: options.prompt,
        maxOutputTokens,
        abortSignal: options.abortSignal ?? abortController.signal,
      });

      return {
        text: response.text,
        usage: response.usage
          ? {
              inputTokens: response.usage.inputTokens ?? 0,
              outputTokens: response.usage.outputTokens ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generates a structured object from a prompt using a Zod schema.
   */
  async object<T>(options: GenerateObjectOptions<T>): Promise<ObjectResult<T>> {
    const model = normalizeModelId(options.model ?? DEFAULT_FAST_MODEL);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxOutputTokens =
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      const response = await generateObject({
        model,
        schema: options.schema,
        system: options.system,
        prompt: options.prompt,
        maxOutputTokens,
        abortSignal: options.abortSignal ?? abortController.signal,
      });

      return {
        object: response.object,
        usage: response.usage
          ? {
              inputTokens: response.usage.inputTokens ?? 0,
              outputTokens: response.usage.outputTokens ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Tests the API connection.
   */
  async test(): Promise<string> {
    const result = await this.text({
      model: DEFAULT_FAST_MODEL,
      prompt: "Say 'OK' in exactly one word.",
      maxOutputTokens: 10,
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    return result.text;
  }
}

/**
 * Creates an AI client instance.
 */
export const createClient = (apiKey?: string): AIClient => new AIClient(apiKey);
