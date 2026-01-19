/**
 * Error types for classifying healing loop failures.
 *
 * Classification reference (Anthropic API):
 * - RATE_LIMIT: 429 rate_limit_error (retryable with backoff)
 * - OVERLOADED: 529 overloaded_error (retryable with backoff)
 * - AUTH_ERROR: 401 authentication_error, 403 permission_error (not retryable)
 * - API_ERROR: 500+ api_error, other server errors (retryable)
 * - TIMEOUT: Request/response timeout (retryable)
 * - TOOL_ERROR: Tool execution failure (depends on tool)
 * - VALIDATION_ERROR: 400 invalid_request_error, schema errors (not retryable)
 * - UNKNOWN: Unclassified errors
 */
export type HealErrorType =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "OVERLOADED"
  | "AUTH_ERROR"
  | "API_ERROR"
  | "TOOL_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

/**
 * Execution context captured at time of failure.
 */
export interface HealErrorContext {
  /** Type of error that occurred */
  errorType: HealErrorType;
  /** Iteration number when error occurred (1-indexed) */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Name of tool that was executing when error occurred (if any) */
  lastTool?: string;
  /** Input provided to the last tool (truncated for readability) */
  lastToolInput?: string;
  /** Token usage at time of failure */
  tokensAtFailure: TokenUsage;
  /** Original error message before formatting */
  rawError: string;
}

/**
 * Configuration for the healing loop.
 */
export interface HealConfig {
  /** Total timeout in milliseconds */
  timeout: number;
  /** Model to use for healing */
  model: string;
  /** Budget limit per run in USD (0 = unlimited) */
  budgetPerRunUSD: number;
  /** Remaining monthly budget in USD (-1 = unlimited) */
  remainingMonthlyUSD: number;
  /** Enable verbose logging */
  verbose: boolean;
}

/**
 * Result of a healing attempt.
 */
export interface HealResult {
  /** Whether the healing was successful */
  success: boolean;
  /** Number of message rounds completed */
  iterations: number;
  /** Model's final response */
  finalMessage: string;
  /** Total number of tool calls made */
  toolCalls: number;
  /** How long the loop took in milliseconds */
  duration: number;
  /** Total input tokens used across all API calls */
  inputTokens: number;
  /** Total output tokens used across all API calls */
  outputTokens: number;
  /** Total tokens used to create cache entries */
  cacheCreationInputTokens: number;
  /** Total tokens read from cache */
  cacheReadInputTokens: number;
  /** Calculated cost in USD based on token usage */
  costUSD: number;
  /** Whether the loop stopped due to budget limit */
  budgetExceeded: boolean;
  /** Which budget was exceeded */
  budgetExceededReason?: "per-run" | "monthly";
  /** Error context when the loop failed (only present on failure) */
  errorContext?: HealErrorContext;
}

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
 * Default configuration values.
 */
export const DEFAULT_CONFIG: HealConfig = {
  timeout: 600_000, // 10 minutes
  model: "claude-sonnet-4-20250514",
  budgetPerRunUSD: 1.0,
  remainingMonthlyUSD: -1, // unlimited by default
  verbose: false,
};
