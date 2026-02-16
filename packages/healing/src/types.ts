import type { TokenUsage } from "@detent/ai";
import type { CommandLogEntry } from "./tools/registry.js";

export type HealErrorType =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "OVERLOADED"
  | "AUTH_ERROR"
  | "API_ERROR"
  | "TOOL_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export interface HealErrorContext {
  errorType: HealErrorType;
  iteration: number;
  maxIterations: number;
  lastTool?: string;
  lastToolInput?: string;
  tokensAtFailure: TokenUsage;
  rawError: string;
}

export interface HealConfig {
  timeout: number;
  model: string;
  budgetPerRunUSD: number;
  remainingMonthlyUSD: number;
  verbose: boolean;
}

export interface HealResult {
  success: boolean;
  iterations: number;
  finalMessage: string;
  toolCalls: number;
  duration: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  budgetExceeded: boolean;
  budgetExceededReason?: "per-run" | "monthly" | "invalid-cost";
  errorContext?: HealErrorContext;
  commandLog?: CommandLogEntry[];
}

export type { TokenUsage } from "@detent/ai";

export const DEFAULT_CONFIG: HealConfig = {
  timeout: 600_000,
  model: "openai/gpt-5.2-codex",
  budgetPerRunUSD: 1.0,
  remainingMonthlyUSD: -1,
  verbose: false,
};
