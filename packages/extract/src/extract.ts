import { createGateway } from "@ai-sdk/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_TIMEOUT_MS,
  estimateCost,
  normalizeModelId,
} from "@detent/ai";
import type { CIError, ErrorSource } from "@detent/types";
import { generateText, Output, stepCountIs } from "ai";
import { type LogSegment, prepareForPrompt } from "./preprocess.js";
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
  type ExtractionMetrics,
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
  type ToolExtractionOptions,
} from "./types.js";

// HACK: \s* only on outer boundaries (not both sides inside the group) to prevent ReDoS
const FILTERED_ONLY_PATTERN = /^\s*(?:\[FILTERED\]\s*)+$/;

const EXTRACTION_OUTPUT = Output.object({ schema: ExtractionResultSchema });

const resolveModel = (modelId: string, apiKey?: string) => {
  if (!apiKey) {
    return modelId;
  }
  const gateway = createGateway({ apiKey });
  return gateway(modelId);
};

const validateModelId = (modelName: string): string => {
  const modelId = normalizeModelId(modelName);
  if (!modelId?.trim()) {
    throw new Error(
      `Invalid model ID after normalization. Original: ${modelName}, got: ${modelId}`
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

const createEmptyResult = (
  truncated: boolean,
  segmentsTruncated: boolean,
  segments?: LogSegment[],
  metrics?: ExtractionResult["metrics"]
): ExtractionResult => ({
  errors: [],
  detectedSource: null,
  truncated,
  segmentsTruncated,
  segments,
  metrics,
});

interface PreparedExtraction {
  model: ReturnType<typeof resolveModel>;
  modelId: string;
  prepared: string;
  truncated: boolean;
  segmentsTruncated: boolean;
  segments: LogSegment[];
  abortSignal: AbortSignal;
  metrics: ExtractionMetrics;
  empty: false;
}

interface EmptyExtraction {
  truncated: boolean;
  segmentsTruncated: boolean;
  segments: LogSegment[];
  metrics: ExtractionMetrics;
  empty: true;
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
): PreparedExtraction | EmptyExtraction => {
  const modelId = validateModelId(options.model ?? DEFAULT_FAST_MODEL);
  const model = resolveModel(modelId, options.apiKey);
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxContentLength = options.maxContentLength ?? 15_000;

  const {
    content: prepared,
    truncated,
    segments,
    segmentsTruncated,
    metrics,
  } = prepareForPrompt(content, maxContentLength);

  if (!prepared.trim() || FILTERED_ONLY_PATTERN.test(prepared)) {
    return { truncated, segmentsTruncated, segments, metrics, empty: true };
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;

  return {
    model,
    modelId,
    prepared,
    truncated,
    segmentsTruncated,
    segments,
    abortSignal,
    metrics,
    empty: false,
  };
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

const buildExtractionResult = (
  prep: PreparedExtraction,
  errors: CIError[],
  detectedSource: ErrorSource | null,
  usage?: { usage: ExtractionUsage; costUsd: number }
): ExtractionResult => ({
  errors,
  detectedSource,
  usage: usage?.usage,
  costUsd: usage?.costUsd,
  truncated: prep.truncated,
  segmentsTruncated: prep.segmentsTruncated,
  segments: prep.segments,
  metrics: prep.metrics,
});

export const extractErrors = async (
  content: string,
  options?: ExtractionOptions
): Promise<ExtractionResult> => {
  const prep = prepareExtraction(content, options ?? {});
  if (prep.empty) {
    return createEmptyResult(
      prep.truncated,
      prep.segmentsTruncated,
      prep.segments,
      prep.metrics
    );
  }

  try {
    const { output, usage } = await generateText({
      model: prep.model,
      output: EXTRACTION_OUTPUT,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildUserPrompt(prep.prepared),
      maxOutputTokens: options?.maxOutputTokens ?? 4096,
      abortSignal: prep.abortSignal,
    });

    if (!output) {
      return createEmptyResult(
        prep.truncated,
        prep.segmentsTruncated,
        prep.segments,
        prep.metrics
      );
    }

    return buildExtractionResult(
      prep,
      output.errors,
      output.detectedSource,
      buildUsage(usage, prep.modelId)
    );
  } catch (error) {
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
  if (prep.empty) {
    return createEmptyResult(
      prep.truncated,
      prep.segmentsTruncated,
      prep.segments,
      prep.metrics
    );
  }

  const maxErrors = options?.maxErrors ?? 200;
  const errors: CIError[] = [];
  let detectedSource: ErrorSource | null = null;

  try {
    const { usage } = await generateText({
      model: prep.model,
      system: EXTRACTION_SYSTEM_PROMPT_TOOLS,
      prompt: buildUserPrompt(prep.prepared),
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
      abortSignal: prep.abortSignal,
    });

    return buildExtractionResult(
      prep,
      errors,
      detectedSource,
      buildUsage(usage, prep.modelId)
    );
  } catch (error) {
    if (errors.length > 0) {
      return buildExtractionResult(prep, errors, detectedSource);
    }
    throw handleExtractionError(error);
  }
};
