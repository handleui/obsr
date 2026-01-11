import { generateText, stepCountIs } from "ai";
import type { Client } from "./client.js";
import { calculateCost } from "./pricing.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { HealConfig, HealResult, TokenUsage } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

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
 * HealLoop orchestrates the agentic healing process.
 */
export class HealLoop {
  private readonly client: Client;
  private readonly registry: ToolRegistry;
  private readonly config: HealConfig;
  private readonly verboseWriter: ((msg: string) => void) | null;

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

    try {
      this.registry.setToolCallListener(
        this.verboseWriter
          ? (toolName: string, input: Record<string, unknown>) =>
              this.logToolCall(toolName, input)
          : null
      );

      const budgetStopCondition = createBudgetStopCondition(
        this.config,
        modelName
      );

      const response = await generateText({
        model: modelName,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: MAX_TOKENS_PER_RESPONSE,
        tools: this.registry.toAiTools(),
        stopWhen: [stepCountIs(MAX_ITERATIONS), budgetStopCondition],
        abortSignal: abortController.signal,
        providerOptions: this.client.providerOptions(modelName) ?? undefined,
      });

      this.updateTokenUsage(result, response.usage ?? {}, modelName);
      result.iterations = response.steps?.length ?? 1;
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

      return { ...result, success: true };
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.costUSD = calculateCost(modelName, getUsageFromResult(result));
      if (abortController.signal.aborted) {
        result.finalMessage = "Healing loop timeout exceeded";
      } else if (error instanceof Error) {
        result.finalMessage = error.message;
      } else {
        result.finalMessage = "Unknown error occurred";
      }
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
