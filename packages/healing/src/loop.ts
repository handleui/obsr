import { generateText, stepCountIs } from "ai";
import type { Client } from "./client.js";
import { calculateCost } from "./pricing.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
  DEFAULT_CONFIG,
  type HealConfig,
  type HealErrorContext,
  type HealErrorType,
  type HealResult,
  type TokenUsage,
} from "./types.js";

/**
 * Mutable execution context for tracking state during the healing loop.
 */
interface ExecutionContext {
  iteration: number;
  lastTool: string | null;
  lastToolInput: string | null;
}

/**
 * Maximum number of tool call rounds (not user-configurable).
 */
const MAX_ITERATIONS = 50;

/**
 * Maximum tokens per response.
 */
const MAX_TOKENS_PER_RESPONSE = 8192;

/**
 * Maps tool names to their key parameter for verbose output.
 */
const KEY_PARAM_NAMES: Record<string, string> = {
  read_file: "path",
  edit_file: "path",
  glob: "pattern",
  grep: "pattern",
  run_check: "category",
  run_command: "command",
};

/**
 * Extracts the most relevant parameter for verbose output.
 */
const extractKeyParam = (
  toolName: string,
  input: Record<string, unknown>
): string => {
  const paramName = KEY_PARAM_NAMES[toolName];
  if (!paramName) {
    return "";
  }

  const value = input[paramName];
  if (typeof value !== "string") {
    return "";
  }

  if (value.length > 50) {
    return `${value.slice(0, 47)}...`;
  }
  return value;
};

/**
 * Creates the initial result object.
 */
const createInitialResult = (): HealResult => ({
  success: false,
  iterations: 0,
  finalMessage: "",
  toolCalls: 0,
  duration: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUSD: 0,
  budgetExceeded: false,
});

/**
 * Calculates token usage from result.
 */
const getUsageFromResult = (result: HealResult): TokenUsage => ({
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  cacheCreationInputTokens: result.cacheCreationInputTokens,
  cacheReadInputTokens: result.cacheReadInputTokens,
});

/**
 * Step usage from AI SDK response.
 */
interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Calculates cumulative cost from step usage data.
 */
const calculateStepsCost = (
  steps: Array<{ usage?: StepUsage }>,
  modelName: string
): number => {
  const totalUsage = steps.reduce(
    (acc, step) => ({
      inputTokens: acc.inputTokens + (step.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (step.usage?.outputTokens ?? 0),
      cacheCreationInputTokens:
        acc.cacheCreationInputTokens +
        (step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0),
      cacheReadInputTokens:
        acc.cacheReadInputTokens +
        (step.usage?.inputTokenDetails?.cacheReadTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }
  );
  return calculateCost(modelName, totalUsage);
};

/**
 * Creates a stop condition that checks budget limits between steps.
 */
const createBudgetStopCondition = (
  config: HealConfig,
  modelName: string
): (({ steps }: { steps: Array<{ usage?: StepUsage }> }) => boolean) => {
  return ({ steps }) => {
    const costUSD = calculateStepsCost(steps, modelName);

    if (config.budgetPerRunUSD > 0 && costUSD > config.budgetPerRunUSD) {
      return true;
    }

    if (
      config.remainingMonthlyUSD >= 0 &&
      costUSD > config.remainingMonthlyUSD
    ) {
      return true;
    }

    return false;
  };
};

/**
 * Checks if budget limits have been exceeded (post-run validation).
 */
const checkBudgetLimits = (
  config: HealConfig,
  result: HealResult,
  startTime: number
): HealResult | null => {
  if (config.budgetPerRunUSD > 0 && result.costUSD > config.budgetPerRunUSD) {
    return {
      ...result,
      budgetExceeded: true,
      budgetExceededReason: "per-run",
      duration: Date.now() - startTime,
    };
  }

  if (
    config.remainingMonthlyUSD >= 0 &&
    result.costUSD > config.remainingMonthlyUSD
  ) {
    return {
      ...result,
      budgetExceeded: true,
      budgetExceededReason: "monthly",
      duration: Date.now() - startTime,
    };
  }

  return null;
};

/**
 * Extracts HTTP status code from error object if available.
 */
const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

/**
 * Maps HTTP status codes to HealErrorType.
 * Based on Anthropic API error codes.
 */
const classifyByStatusCode = (status: number): HealErrorType | null => {
  if (status === 429) {
    return "RATE_LIMIT";
  }
  if (status === 529) {
    return "OVERLOADED";
  }
  if (status === 401 || status === 403) {
    return "AUTH_ERROR";
  }
  if (status >= 500) {
    return "API_ERROR";
  }
  if (status === 400 || status === 413 || status === 422) {
    return "VALIDATION_ERROR";
  }
  return null;
};

/**
 * Patterns for classifying errors by message content.
 * Order matters: more specific patterns should come first.
 */
const ERROR_MESSAGE_PATTERNS: Array<{
  type: HealErrorType;
  patterns: string[];
}> = [
  {
    type: "RATE_LIMIT",
    patterns: ["rate limit", "rate_limit", "too many requests", "429"],
  },
  {
    type: "OVERLOADED",
    patterns: ["overloaded", "529"],
  },
  {
    type: "AUTH_ERROR",
    patterns: [
      "authentication",
      "unauthorized",
      "invalid_api_key",
      "invalid api key",
      "permission denied",
      "permission_error",
      "forbidden",
      "401",
      "403",
    ],
  },
  {
    type: "API_ERROR",
    patterns: [
      "internal server",
      "internal_error",
      "api_error",
      "service unavailable",
      "bad gateway",
      "500",
      "502",
      "503",
      "504",
    ],
  },
  {
    type: "VALIDATION_ERROR",
    patterns: [
      "validation",
      "invalid",
      "schema",
      "parse",
      "request_too_large",
      "too large",
      "400",
      "413",
      "422",
    ],
  },
];

/**
 * Classifies error by message content using pattern matching.
 */
const classifyByMessage = (msg: string): HealErrorType | null => {
  for (const { type, patterns } of ERROR_MESSAGE_PATTERNS) {
    if (patterns.some((pattern) => msg.includes(pattern))) {
      return type;
    }
  }
  return null;
};

/**
 * Classifies an error into a HealErrorType.
 *
 * Classification follows Anthropic API error types:
 * - 429: rate_limit_error -> RATE_LIMIT
 * - 529: overloaded_error -> OVERLOADED
 * - 401/403: authentication_error, permission_error -> AUTH_ERROR
 * - 500+: api_error, internal errors -> API_ERROR
 * - 400/413/422: invalid_request_error, request_too_large -> VALIDATION_ERROR
 * - Timeout/abort -> TIMEOUT
 * - Tool failures -> TOOL_ERROR
 */
const classifyError = (
  error: unknown,
  isAborted: boolean,
  lastTool: string | null
): HealErrorType => {
  if (isAborted) {
    return "TIMEOUT";
  }

  // Check HTTP status code first (most reliable)
  const status = getErrorStatus(error);
  if (status !== undefined) {
    const statusType = classifyByStatusCode(status);
    if (statusType) {
      return statusType;
    }
  }

  if (!(error instanceof Error)) {
    return "UNKNOWN";
  }

  const msg = error.message.toLowerCase();

  // Try message pattern matching
  const messageType = classifyByMessage(msg);
  if (messageType) {
    return messageType;
  }

  // Tool execution errors (check after other patterns to avoid false positives)
  if (lastTool || msg.includes("tool")) {
    return "TOOL_ERROR";
  }

  return "UNKNOWN";
};

/**
 * Sanitizes error messages to remove potential API keys or sensitive data.
 *
 * NOTE: This is the canonical credential sanitization function for the healing package.
 * If adding new credential patterns, consider if similar logic is needed in:
 * - Sentry error reporting (apps/api/src/lib/sentry.ts)
 * - GitHub secrets helper (apps/api/src/lib/github-secrets-helper.ts)
 *
 * Patterns covered:
 * - Anthropic API keys (sk-ant-*)
 * - OpenAI API keys (sk-*)
 * - GitHub tokens (ghp_*, gho_*, ghu_*, ghs_*, ghr_*, github_pat_*)
 * - Detent tokens (dtk_*)
 * - Bearer tokens
 * - Generic secrets in key/token/secret/password contexts
 */
const sanitizeErrorMessage = (message: string): string => {
  // Anthropic API key patterns
  let sanitized = message.replace(
    /sk-ant-[a-zA-Z0-9_-]{20,}/gi,
    "[REDACTED_API_KEY]"
  );

  // OpenAI API key patterns
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9]{20,}/gi, "[REDACTED_API_KEY]");

  // Generic Bearer tokens
  sanitized = sanitized.replace(
    /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
    "Bearer [REDACTED_TOKEN]"
  );

  // GitHub classic tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  sanitized = sanitized.replace(
    /gh[pousr]_[a-zA-Z0-9_]{20,}/gi,
    "[REDACTED_GITHUB_TOKEN]"
  );

  // GitHub fine-grained PATs
  sanitized = sanitized.replace(
    /github_pat_[a-zA-Z0-9_]{20,}/gi,
    "[REDACTED_GITHUB_PAT]"
  );

  // Detent tokens
  sanitized = sanitized.replace(
    /dtk_[a-zA-Z0-9_-]{20,}/gi,
    "[REDACTED_DETENT_TOKEN]"
  );

  // x-api-key header values
  sanitized = sanitized.replace(
    /x-api-key[:\s]+[a-zA-Z0-9_-]{20,}/gi,
    "x-api-key: [REDACTED]"
  );

  // Generic long secrets in key/token/secret/password contexts
  sanitized = sanitized.replace(
    /(api[_-]?key|token|secret|password|credential)[:\s=]+['"]?[a-zA-Z0-9_-]{20,}['"]?/gi,
    "$1: [REDACTED]"
  );

  return sanitized;
};

/**
 * Formats an error message with execution context.
 */
const formatErrorMessage = (
  errorType: HealErrorType,
  rawError: string,
  execCtx: ExecutionContext
): string => {
  const iterationInfo = `iteration ${execCtx.iteration}/${MAX_ITERATIONS}`;
  const safeError = sanitizeErrorMessage(rawError);

  switch (errorType) {
    case "TIMEOUT":
      if (execCtx.lastTool) {
        return `[${execCtx.lastTool}] Timeout exceeded at ${iterationInfo}`;
      }
      return `Timeout exceeded at ${iterationInfo}`;

    case "RATE_LIMIT":
      return `Rate limited at ${iterationInfo}: ${safeError}`;

    case "OVERLOADED":
      return `API overloaded at ${iterationInfo}: ${safeError}`;

    case "AUTH_ERROR":
      return `Authentication failed at ${iterationInfo}: ${safeError}`;

    case "TOOL_ERROR":
      if (execCtx.lastTool) {
        const toolInput = execCtx.lastToolInput
          ? ` on ${execCtx.lastToolInput}`
          : "";
        return `[${execCtx.lastTool}] Tool execution failed at ${iterationInfo}: ${safeError}${toolInput}`;
      }
      return `Tool execution failed at ${iterationInfo}: ${safeError}`;

    case "API_ERROR":
      return `API error at ${iterationInfo}: ${safeError}`;

    case "VALIDATION_ERROR":
      if (execCtx.lastTool) {
        return `[${execCtx.lastTool}] Validation error at ${iterationInfo}: ${safeError}`;
      }
      return `Validation error at ${iterationInfo}: ${safeError}`;

    default:
      if (execCtx.lastTool) {
        return `[${execCtx.lastTool}] Error at ${iterationInfo}: ${safeError}`;
      }
      return `Error at ${iterationInfo}: ${safeError}`;
  }
};

/**
 * Builds error context from execution state.
 * Note: rawError is sanitized to prevent API key leakage in logs/storage.
 */
const buildErrorContext = (
  errorType: HealErrorType,
  rawError: string,
  execCtx: ExecutionContext,
  result: HealResult
): HealErrorContext => ({
  errorType,
  iteration: execCtx.iteration,
  maxIterations: MAX_ITERATIONS,
  lastTool: execCtx.lastTool ?? undefined,
  lastToolInput: execCtx.lastToolInput ?? undefined,
  tokensAtFailure: {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
  },
  rawError: sanitizeErrorMessage(rawError),
});

/**
 * HealLoop orchestrates the agentic healing process.
 */
export class HealLoop {
  private readonly client: Client;
  private readonly registry: ToolRegistry;
  private readonly config: HealConfig;
  private readonly verboseWriter: ((msg: string) => void) | null;
  private readonly execCtx: ExecutionContext;

  constructor(
    client: Client,
    registry: ToolRegistry,
    config: Partial<HealConfig> = {}
  ) {
    this.client = client;
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.verboseWriter = this.config.verbose
      ? (msg: string) => process.stderr.write(msg)
      : null;
    this.execCtx = { iteration: 0, lastTool: null, lastToolInput: null };
  }

  /**
   * Executes the healing loop with the given system prompt and initial user message.
   */
  run = async (
    systemPrompt: string,
    userPrompt: string
  ): Promise<HealResult> => {
    const startTime = Date.now();
    const result = createInitialResult();
    const modelName = this.client.normalizeModel(this.config.model);
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      this.config.timeout
    );

    // Reset execution context for this run
    this.execCtx.iteration = 1;
    this.execCtx.lastTool = null;
    this.execCtx.lastToolInput = null;

    try {
      // Set up tool call listener that tracks context and optionally logs
      this.registry.setToolCallListener(
        (toolName: string, input: Record<string, unknown>) => {
          this.execCtx.lastTool = toolName;
          this.execCtx.lastToolInput = extractKeyParam(toolName, input) || null;
          if (this.verboseWriter) {
            this.logToolCall(toolName, input);
          }
        }
      );

      const budgetStopCondition = createBudgetStopCondition(
        this.config,
        modelName
      );

      const response = await generateText({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userPrompt,
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              },
            ],
          },
        ],
        maxOutputTokens: MAX_TOKENS_PER_RESPONSE,
        maxRetries: 5,
        tools: this.registry.toAiTools(),
        stopWhen: [stepCountIs(MAX_ITERATIONS), budgetStopCondition],
        abortSignal: abortController.signal,
        providerOptions: this.client.providerOptions(modelName) ?? undefined,
      });

      this.updateTokenUsage(result, response.usage ?? {}, modelName);
      result.iterations = response.steps?.length ?? 1;
      // Update execution context with final iteration count
      this.execCtx.iteration = result.iterations;
      result.toolCalls =
        response.steps?.flatMap((step) => step.toolCalls ?? []).length ?? 0;
      result.finalMessage = response.text ?? "";
      result.duration = Date.now() - startTime;

      const budgetExceeded = checkBudgetLimits(this.config, result, startTime);
      if (budgetExceeded) {
        return {
          ...budgetExceeded,
          finalMessage: result.finalMessage,
        };
      }

      // Detect if we hit the step limit without natural completion
      const hitStepLimit = result.iterations >= MAX_ITERATIONS;
      if (hitStepLimit) {
        result.finalMessage =
          result.finalMessage ||
          `Max iterations (${MAX_ITERATIONS}) reached without completion`;
        return result;
      }

      return { ...result, success: true };
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.costUSD = calculateCost(modelName, getUsageFromResult(result));

      // Extract raw error message
      const rawError =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Classify the error
      const errorType = classifyError(
        error,
        abortController.signal.aborted,
        this.execCtx.lastTool
      );

      // Build error context for debugging
      result.errorContext = buildErrorContext(
        errorType,
        rawError,
        this.execCtx,
        result
      );

      // Format user-friendly error message with context
      result.finalMessage = formatErrorMessage(
        errorType,
        rawError,
        this.execCtx
      );

      return result;
    } finally {
      clearTimeout(timeoutId);
      this.registry.setToolCallListener(null);
    }
  };

  /**
   * Updates the result with token usage from response.
   */
  private readonly updateTokenUsage = (
    result: HealResult,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    },
    modelName: string
  ): void => {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

    result.inputTokens = inputTokens;
    result.outputTokens = outputTokens;
    result.cacheCreationInputTokens = cacheWriteTokens;
    result.cacheReadInputTokens = cacheReadTokens;
    result.costUSD = calculateCost(modelName, getUsageFromResult(result));
  };

  /**
   * Logs a tool call in verbose mode with the key parameter.
   */
  private readonly logToolCall = (
    toolName: string,
    input: Record<string, unknown>
  ): void => {
    if (!this.verboseWriter) {
      return;
    }

    const keyParam = extractKeyParam(toolName, input);
    if (keyParam) {
      this.verboseWriter(`  -> ${toolName}: ${keyParam}\n`);
    } else {
      this.verboseWriter(`  -> ${toolName}\n`);
    }
  };
}

/**
 * Creates a config from settings.
 * This is the canonical way to configure the healing loop from application settings.
 */
export const createConfig = (
  model: string,
  timeoutMins: number,
  budgetPerRunUSD: number,
  remainingMonthlyUSD: number
): HealConfig => ({
  timeout: timeoutMins > 0 ? timeoutMins * 60_000 : DEFAULT_CONFIG.timeout,
  model: model || DEFAULT_CONFIG.model,
  budgetPerRunUSD:
    budgetPerRunUSD >= 0 ? budgetPerRunUSD : DEFAULT_CONFIG.budgetPerRunUSD,
  remainingMonthlyUSD,
  verbose: false,
});
