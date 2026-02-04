import {
  calculateCost,
  createCacheableSystemMessage,
  createCachePrepareStep,
  normalizeModelId,
} from "@detent/ai";
import { redactSensitiveData } from "@detent/types";
import { generateText, stepCountIs } from "ai";
import type { ToolRegistry } from "./tools/registry.js";
import {
  DEFAULT_CONFIG,
  type HealConfig,
  type HealErrorContext,
  type HealErrorType,
  type HealResult,
  type TokenUsage,
} from "./types.js";

interface ExecutionContext {
  iteration: number;
  lastTool: string | null;
  lastToolInput: string | null;
}

const MAX_ITERATIONS = 50;

const MAX_TOKENS_PER_RESPONSE = 8192;

const KEY_PARAM_NAMES: Record<string, string> = {
  read_file: "path",
  edit_file: "path",
  glob: "pattern",
  grep: "pattern",
  run_check: "category",
  run_command: "command",
};

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

const getUsageFromResult = (result: HealResult): TokenUsage => ({
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  cacheCreationInputTokens: result.cacheCreationInputTokens,
  cacheReadInputTokens: result.cacheReadInputTokens,
});

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

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

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

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

const classifyByMessage = (msg: string): HealErrorType | null => {
  for (const { type, patterns } of ERROR_MESSAGE_PATTERNS) {
    if (patterns.some((pattern) => msg.includes(pattern))) {
      return type;
    }
  }
  return null;
};

const classifyError = (
  error: unknown,
  isAborted: boolean,
  lastTool: string | null
): HealErrorType => {
  if (isAborted) {
    return "TIMEOUT";
  }

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

  const messageType = classifyByMessage(msg);
  if (messageType) {
    return messageType;
  }

  if (lastTool || msg.includes("tool")) {
    return "TOOL_ERROR";
  }

  return "UNKNOWN";
};

const formatErrorMessage = (
  errorType: HealErrorType,
  rawError: string,
  execCtx: ExecutionContext
): string => {
  const iterationInfo = `iteration ${execCtx.iteration}/${MAX_ITERATIONS}`;
  const safeError = redactSensitiveData(rawError);

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
  rawError: redactSensitiveData(rawError),
});

export class HealLoop {
  private readonly registry: ToolRegistry;
  private readonly config: HealConfig;
  private readonly verboseWriter: ((msg: string) => void) | null;
  private readonly execCtx: ExecutionContext;

  constructor(registry: ToolRegistry, config: Partial<HealConfig> = {}) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.verboseWriter = this.config.verbose
      ? (msg: string) => process.stderr.write(msg)
      : null;
    this.execCtx = { iteration: 0, lastTool: null, lastToolInput: null };
  }

  run = async (
    systemPrompt: string,
    userPrompt: string
  ): Promise<HealResult> => {
    const startTime = Date.now();
    const result = createInitialResult();
    const modelName = normalizeModelId(this.config.model);
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      this.config.timeout
    );

    this.execCtx.iteration = 1;
    this.execCtx.lastTool = null;
    this.execCtx.lastToolInput = null;

    try {
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
          createCacheableSystemMessage(systemPrompt),
          { role: "user", content: userPrompt },
        ],
        maxOutputTokens: MAX_TOKENS_PER_RESPONSE,
        maxRetries: 5,
        tools: this.registry.toAiTools(),
        stopWhen: [stepCountIs(MAX_ITERATIONS), budgetStopCondition],
        abortSignal: abortController.signal,
        prepareStep: createCachePrepareStep(),
      });

      this.updateTokenUsage(result, response.usage ?? {}, modelName);
      result.iterations = response.steps?.length ?? 1;
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

      const rawError =
        error instanceof Error ? error.message : "Unknown error occurred";

      const errorType = classifyError(
        error,
        abortController.signal.aborted,
        this.execCtx.lastTool
      );

      result.errorContext = buildErrorContext(
        errorType,
        rawError,
        this.execCtx,
        result
      );

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
