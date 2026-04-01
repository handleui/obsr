import {
  calculateCost,
  createCacheableSystemMessage,
  createCachePrepareStep,
  normalizeModelId,
} from "@obsr/ai";
import { redactSensitiveData } from "@obsr/types";
import { generateText, stepCountIs } from "ai";
import type { ToolRegistry } from "./tools/registry.js";
import {
  DEFAULT_CONFIG,
  type ResolveConfig,
  type ResolveErrorContext,
  type ResolveErrorType,
  type ResolveResult,
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

const MAX_KEY_PARAM_LENGTH = 50;

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

  return value.length > MAX_KEY_PARAM_LENGTH
    ? `${value.slice(0, MAX_KEY_PARAM_LENGTH - 3)}...`
    : value;
};

const createInitialResult = (): ResolveResult => ({
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

const getUsageFromResult = (result: ResolveResult): TokenUsage => ({
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  cacheCreationInputTokens: result.cacheCreationInputTokens,
  cacheReadInputTokens: result.cacheReadInputTokens,
});

const calculateAccumulatedCost = (
  accumulated: TokenUsage,
  modelName: string
): number => calculateCost(modelName, accumulated);

const checkBudgetLimits = (
  config: ResolveConfig,
  result: ResolveResult,
  startTime: number
): ResolveResult | null => {
  if (!Number.isFinite(result.costUSD) || result.costUSD < 0) {
    return {
      ...result,
      budgetExceeded: true,
      budgetExceededReason: "invalid-cost",
      duration: Date.now() - startTime,
    };
  }

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

const classifyByStatusCode = (status: number): ResolveErrorType | null => {
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
  type: ResolveErrorType;
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

const classifyByMessage = (msg: string): ResolveErrorType | null => {
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
): ResolveErrorType => {
  if (isAborted) {
    return "TIMEOUT";
  }

  if (error instanceof Error && error.name === "AbortError") {
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

const formatWithTool = (
  label: string,
  iterationInfo: string,
  safeError: string,
  lastTool: string | null
): string => {
  if (lastTool) {
    return `[${lastTool}] ${label} at ${iterationInfo}: ${safeError}`;
  }
  return `${label} at ${iterationInfo}: ${safeError}`;
};

const formatErrorMessage = (
  errorType: ResolveErrorType,
  rawError: string,
  execCtx: ExecutionContext
): string => {
  const iterationInfo = `iteration ${execCtx.iteration}/${MAX_ITERATIONS}`;
  const safeError = redactSensitiveData(rawError);

  switch (errorType) {
    case "TIMEOUT": {
      const base = `Timeout exceeded at ${iterationInfo}`;
      return execCtx.lastTool ? `[${execCtx.lastTool}] ${base}` : base;
    }
    case "RATE_LIMIT":
      return `Rate limited at ${iterationInfo}: ${safeError}`;
    case "OVERLOADED":
      return `API overloaded at ${iterationInfo}: ${safeError}`;
    case "AUTH_ERROR":
      return `Authentication failed at ${iterationInfo}: ${safeError}`;
    case "TOOL_ERROR": {
      const toolInput = execCtx.lastToolInput
        ? ` on ${execCtx.lastToolInput}`
        : "";
      return `${formatWithTool("Tool execution failed", iterationInfo, safeError, execCtx.lastTool)}${toolInput}`;
    }
    case "API_ERROR":
      return `API error at ${iterationInfo}: ${safeError}`;
    case "VALIDATION_ERROR":
      return formatWithTool(
        "Validation error",
        iterationInfo,
        safeError,
        execCtx.lastTool
      );
    default:
      return formatWithTool(
        "Error",
        iterationInfo,
        safeError,
        execCtx.lastTool
      );
  }
};

const buildErrorContext = (
  errorType: ResolveErrorType,
  rawError: string,
  execCtx: ExecutionContext,
  result: ResolveResult
): ResolveErrorContext => ({
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

const MAX_REPAIR_INPUT_SIZE = 1_000_000;

const createEmptyAccumulator = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

const isBudgetExceeded = (costUSD: number, config: ResolveConfig): boolean =>
  (config.budgetPerRunUSD > 0 && costUSD > config.budgetPerRunUSD) ||
  (config.remainingMonthlyUSD >= 0 && costUSD > config.remainingMonthlyUSD);

const accumulateUsage = (
  accumulated: TokenUsage,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {
      cacheWriteTokens?: number;
      cacheReadTokens?: number;
    };
  }
): void => {
  accumulated.inputTokens += usage.inputTokens ?? 0;
  accumulated.outputTokens += usage.outputTokens ?? 0;
  accumulated.cacheCreationInputTokens +=
    usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  accumulated.cacheReadInputTokens +=
    usage.inputTokenDetails?.cacheReadTokens ?? 0;
};

interface SdkToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
}

const repairToolCall = ({
  toolCall,
}: {
  toolCall: SdkToolCall;
}): Promise<SdkToolCall | null> => {
  if (typeof toolCall.input !== "string") {
    return Promise.resolve(null);
  }
  if (toolCall.input.length > MAX_REPAIR_INPUT_SIZE) {
    return Promise.resolve(null);
  }

  const cleaned = toolCall.input
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/'/g, '"');

  try {
    JSON.parse(cleaned);
    return Promise.resolve({ ...toolCall, input: cleaned });
  } catch {
    return Promise.resolve(null);
  }
};

interface UsageInput {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface StepEvent {
  toolCalls?: Array<{ toolName: string }>;
  finishReason: string;
  usage?: UsageInput;
}

export class ResolveLoop {
  private readonly registry: ToolRegistry;
  private readonly config: ResolveConfig;
  private readonly verboseWriter: ((msg: string) => void) | null;
  private readonly execCtx: ExecutionContext;

  constructor(registry: ToolRegistry, config: Partial<ResolveConfig> = {}) {
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
  ): Promise<ResolveResult> => {
    const startTime = Date.now();
    const result = createInitialResult();
    const modelName = normalizeModelId(this.config.model);
    const abortController = new AbortController();

    this.resetExecCtx();

    try {
      this.registry.setToolCallListener(this.handleToolCall);

      const response = await generateText({
        model: modelName,
        messages: [
          createCacheableSystemMessage(systemPrompt),
          { role: "user", content: userPrompt },
        ],
        maxOutputTokens: MAX_TOKENS_PER_RESPONSE,
        maxRetries: 5,
        tools: this.registry.toAiTools(),
        stopWhen: stepCountIs(MAX_ITERATIONS),
        // HACK: 120s per step — generous limit for tool-heavy iterations (clone, install, build)
        timeout: { totalMs: this.config.timeout, stepMs: 120_000 },
        abortSignal: abortController.signal,
        prepareStep: createCachePrepareStep(),
        onStepFinish: this.createStepHandler(modelName, abortController),
        experimental_repairToolCall: repairToolCall,
        experimental_include: { requestBody: false },
      });

      return this.finalizeSuccess(result, response, modelName, startTime);
    } catch (error) {
      return this.finalizeError(
        result,
        error,
        modelName,
        abortController,
        startTime
      );
    } finally {
      this.registry.setToolCallListener(null);
    }
  };

  private readonly resetExecCtx = (): void => {
    this.execCtx.iteration = 1;
    this.execCtx.lastTool = null;
    this.execCtx.lastToolInput = null;
    this.registry.currentStep = 1;
  };

  private readonly handleToolCall = (
    toolName: string,
    input: Record<string, unknown>
  ): void => {
    this.execCtx.lastTool = toolName;
    this.execCtx.lastToolInput = extractKeyParam(toolName, input) || null;
    this.logToolCall(toolName, input);
  };

  private readonly createStepHandler = (
    modelName: string,
    abortController: AbortController
  ) => {
    const accumulated = createEmptyAccumulator();
    let stepStart = Date.now();

    return ({ toolCalls, finishReason, usage }: StepEvent): void => {
      const stepDurationMs = Date.now() - stepStart;

      if (usage) {
        accumulateUsage(accumulated, usage);
      }
      this.logStepProgress(toolCalls, finishReason, stepDurationMs);
      this.execCtx.iteration++;
      this.registry.currentStep = this.execCtx.iteration;

      const costUSD = calculateAccumulatedCost(accumulated, modelName);
      if (
        !Number.isFinite(costUSD) ||
        costUSD < 0 ||
        isBudgetExceeded(costUSD, this.config)
      ) {
        abortController.abort();
      }

      stepStart = Date.now();
    };
  };

  private readonly finalizeSuccess = (
    result: ResolveResult,
    response: {
      totalUsage: UsageInput;
      steps: Array<{ toolCalls: unknown[] }>;
      text: string;
    },
    modelName: string,
    startTime: number
  ): ResolveResult => {
    this.applyTokenUsage(result, response.totalUsage, modelName);
    result.iterations = response.steps.length;
    this.execCtx.iteration = result.iterations;
    this.registry.currentStep = result.iterations;
    result.toolCalls = response.steps.flatMap((step) => step.toolCalls).length;
    result.finalMessage = response.text;
    result.duration = Date.now() - startTime;
    result.commandLog = this.registry.auditLog;

    const budgetExceeded = checkBudgetLimits(this.config, result, startTime);
    if (budgetExceeded) {
      return { ...budgetExceeded, finalMessage: result.finalMessage };
    }

    if (result.iterations >= MAX_ITERATIONS) {
      result.finalMessage =
        result.finalMessage ||
        `Max iterations (${MAX_ITERATIONS}) reached without completion`;
      return result;
    }

    return { ...result, success: true };
  };

  private readonly finalizeError = (
    result: ResolveResult,
    error: unknown,
    modelName: string,
    abortController: AbortController,
    startTime: number
  ): ResolveResult => {
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
    result.finalMessage = formatErrorMessage(errorType, rawError, this.execCtx);
    return result;
  };

  private readonly applyTokenUsage = (
    result: ResolveResult,
    usage: UsageInput,
    modelName: string
  ): void => {
    result.inputTokens = usage.inputTokens ?? 0;
    result.outputTokens = usage.outputTokens ?? 0;
    result.cacheCreationInputTokens =
      usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    result.cacheReadInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    result.costUSD = calculateCost(modelName, getUsageFromResult(result));
  };

  private readonly logStepProgress = (
    toolCalls: Array<{ toolName: string }> | undefined,
    finishReason: string,
    stepDurationMs: number
  ): void => {
    if (!this.verboseWriter) {
      return;
    }
    const tools = toolCalls?.map((tc) => tc.toolName).join(", ") || "none";
    this.verboseWriter(
      `  step ${this.execCtx.iteration}: tools=[${tools}] reason=${finishReason} duration=${stepDurationMs}ms\n`
    );
  };

  private readonly logToolCall = (
    toolName: string,
    input: Record<string, unknown>
  ): void => {
    if (!this.verboseWriter) {
      return;
    }
    const keyParam = extractKeyParam(toolName, input);
    const message = keyParam
      ? `  -> ${toolName}: ${keyParam}\n`
      : `  -> ${toolName}\n`;
    this.verboseWriter(message);
  };
}

export const createConfig = (
  model: string,
  timeoutMins: number,
  budgetPerRunUSD: number,
  remainingMonthlyUSD: number
): ResolveConfig => {
  const hasNonFinite = !(
    Number.isFinite(timeoutMins) &&
    Number.isFinite(budgetPerRunUSD) &&
    Number.isFinite(remainingMonthlyUSD)
  );
  if (hasNonFinite) {
    throw new Error("Config values must be finite numbers");
  }

  return {
    timeout: timeoutMins > 0 ? timeoutMins * 60_000 : DEFAULT_CONFIG.timeout,
    model: model || DEFAULT_CONFIG.model,
    budgetPerRunUSD:
      budgetPerRunUSD >= 0 ? budgetPerRunUSD : DEFAULT_CONFIG.budgetPerRunUSD,
    remainingMonthlyUSD,
    verbose: false,
  };
};
