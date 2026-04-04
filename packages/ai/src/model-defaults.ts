export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ResponseUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelConfig {
  model: string;
  maxOutputTokens?: number;
  timeout?: number;
}

export const DEFAULT_FAST_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_SMART_MODEL = "openai/gpt-5.2-codex";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
