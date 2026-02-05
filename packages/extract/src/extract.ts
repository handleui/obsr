import { createGateway } from "@ai-sdk/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_TIMEOUT_MS,
  estimateCost,
  normalizeModelId,
} from "@detent/ai";
import type { CIError, ErrorSource } from "@detent/types";
import {
  generateObject,
  generateText,
  NoObjectGeneratedError,
  stepCountIs,
} from "ai";
import { prepareForPrompt } from "./preprocess.js";
import {
  buildUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_TOOLS,
} from "./prompt.js";
import {
  createRegisterErrorTool,
  createSetDetectedSourceTool,
} from "./tools.js";
import {
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
  type ToolExtractionOptions,
} from "./types.js";

const FILTERED_ONLY_PATTERN = /^(\s*\[FILTERED\]\s*)+$/;

const resolveModel = (modelId: string, apiKey?: string) => {
  if (!apiKey) {
    return modelId;
  }
  const gateway = createGateway({ apiKey });
  return gateway(modelId);
};

const validateModelId = (modelName: string): string => {
  let modelId: string;
  try {
    modelId = normalizeModelId(modelName);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown normalization error";
    throw new Error(
      `Invalid model ID after normalization. Original: ${modelName}. ${message}`
    );
  }

  if (!modelId?.trim()) {
    throw new Error(
      `Model normalization produced invalid result. Input: ${modelName}, Output: ${modelId}`
    );
  }

  return modelId;
};

export interface ExtractionOptions {
  model?: string;
  maxOutputTokens?: number;
  timeout?: number;
  abortSignal?: AbortSignal;
  maxContentLength?: number;
  apiKey?: string;
}

const createEmptyResult = (truncated: boolean): ExtractionResult => ({
  errors: [],
  detectedSource: null,
  truncated,
});

interface PreparedExtraction {
  model: ReturnType<typeof resolveModel>;
  modelId: string;
  prepared: string;
  truncated: boolean;
  abortSignal: AbortSignal;
}

const prepareExtraction = (
  content: string,
  options: {
    model?: string;
    apiKey?: string;
    timeout?: number;
    maxContentLength?: number;
    abortSignal?: AbortSignal;
  }
): PreparedExtraction | null => {
  const modelId = validateModelId(options.model ?? DEFAULT_FAST_MODEL);
  const model = resolveModel(modelId, options.apiKey);
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxContentLength = options.maxContentLength ?? 15_000;

  const { content: prepared, truncated } = prepareForPrompt(
    content,
    maxContentLength
  );

  if (!prepared.trim() || FILTERED_ONLY_PATTERN.test(prepared)) {
    return null;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;

  return { model, modelId, prepared, truncated, abortSignal };
};

const buildUsage = (
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
  modelId: string
) => {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    } as ExtractionUsage,
    costUsd: estimateCost(modelId, inputTokens, outputTokens),
  };
};

const handleExtractionError = (error: unknown): Error => {
  const isTimeout =
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  return new Error(
    isTimeout ? "AI extraction timed out" : "AI extraction failed"
  );
};

const emptyResultForContent = (
  content: string,
  maxContentLength: number
): ExtractionResult => {
  const { truncated } = prepareForPrompt(content, maxContentLength);
  return createEmptyResult(truncated);
};

const DEFAULT_MAX_CONTENT_LENGTH = 15_000;

export const extractErrors = async (
  content: string,
  options?: ExtractionOptions
): Promise<ExtractionResult> => {
  const prep = prepareExtraction(content, options ?? {});
  if (!prep) {
    return emptyResultForContent(
      content,
      options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH
    );
  }

  const { model, modelId, prepared, truncated, abortSignal } = prep;

  try {
    const { object, usage } = await generateObject({
      model,
      schema: ExtractionResultSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildUserPrompt(prepared),
      maxOutputTokens: options?.maxOutputTokens ?? 4096,
      abortSignal,
    });

    const { usage: extractionUsage, costUsd } = buildUsage(usage, modelId);

    return {
      errors: object.errors,
      detectedSource: object.detectedSource,
      usage: extractionUsage,
      costUsd,
      truncated,
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return createEmptyResult(truncated);
    }
    throw handleExtractionError(error);
  }
};

// HACK: Experimental tool-based extraction kept for future "bidirectional terminal" product.
// Uses register_error tool calls instead of generateObject for streaming error extraction.
// biome-ignore lint/correctness/noUnusedVariables: Experimental - kept for future "bidirectional terminal" product
const extractErrorsWithTools = async (
  content: string,
  options?: ToolExtractionOptions
): Promise<ExtractionResult> => {
  const prep = prepareExtraction(content, options ?? {});
  if (!prep) {
    return emptyResultForContent(
      content,
      options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH
    );
  }

  const { model, modelId, prepared, truncated, abortSignal } = prep;
  const maxErrors = options?.maxErrors ?? 200;
  const errors: CIError[] = [];
  let detectedSource: ErrorSource | null = null;

  try {
    const { usage } = await generateText({
      model,
      system: EXTRACTION_SYSTEM_PROMPT_TOOLS,
      prompt: buildUserPrompt(prepared),
      stopWhen: stepCountIs(maxErrors + 10),
      tools: {
        register_error: createRegisterErrorTool(async (error) => {
          if (errors.length < maxErrors) {
            errors.push(error);
            await options?.onError?.(error);
          }
        }),
        set_detected_source: createSetDetectedSourceTool((source) => {
          detectedSource = source;
        }),
      },
      maxOutputTokens: options?.maxOutputTokens ?? 8192,
      abortSignal,
    });

    const { usage: extractionUsage, costUsd } = buildUsage(usage, modelId);

    return {
      errors,
      detectedSource,
      usage: extractionUsage,
      costUsd,
      truncated,
    };
  } catch (error) {
    if (errors.length > 0) {
      return { errors, detectedSource, truncated };
    }
    throw handleExtractionError(error);
  }
};
