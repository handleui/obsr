/**
 * Token usage for cost calculation.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Model configuration.
 */
export interface ModelConfig {
  /** Model identifier (e.g., "anthropic/claude-haiku-4-5") */
  model: string;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Default model for quick/cheap operations.
 */
export const DEFAULT_FAST_MODEL = "anthropic/claude-haiku-4-5";

/**
 * Default model for complex operations.
 */
export const DEFAULT_SMART_MODEL = "openai/gpt-5.2-codex";

/**
 * Default timeout in milliseconds (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default max output tokens.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
