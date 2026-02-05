import { createGateway } from "@ai-sdk/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_TIMEOUT_MS,
  estimateCost,
  normalizeModelId,
} from "@detent/ai";
import { generateObject, NoObjectGeneratedError } from "ai";
import { prepareForPrompt } from "./preprocess.js";
import { buildUserPrompt, EXTRACTION_SYSTEM_PROMPT } from "./prompt.js";
import {
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
} from "./types.js";

/**
 * Pattern to detect content that consists only of [FILTERED] markers and whitespace.
 * Used to skip AI processing for content that was purely injection attempts.
 */
const FILTERED_ONLY_PATTERN = /^(\s*\[FILTERED\]\s*)+$/;

/**
 * Resolves the model to use for extraction.
 * When an API key is provided, creates a custom gateway instance.
 * Otherwise uses a string model ID that relies on AI_GATEWAY_API_KEY env var.
 */
const resolveModel = (modelId: string, apiKey?: string) => {
  if (apiKey) {
    const gateway = createGateway({ apiKey });
    return gateway(modelId);
  }
  return modelId;
};

/**
 * Options for error extraction.
 */
export interface ExtractionOptions {
  /** Model to use (default: claude-haiku-4-5) */
  model?: string;
  /** Maximum output tokens (default: 4096) */
  maxOutputTokens?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Maximum content length to process (default: 15000) */
  maxContentLength?: number;
  /**
   * AI Gateway API key. Required in environments where process.env is not
   * available (e.g., Cloudflare Workers). Falls back to AI_GATEWAY_API_KEY
   * environment variable when not provided.
   */
  apiKey?: string;
}

/**
 * Creates an empty extraction result for error cases.
 */
const createEmptyResult = (truncated: boolean): ExtractionResult => ({
  errors: [],
  detectedSource: null,
  truncated,
});

/**
 * Extracts errors from CI output using AI.
 *
 * Uses Haiku to parse any CI output format and extract structured errors.
 * This replaces regex-based parsing with a universal AI approach.
 *
 * @param content - Raw CI output to parse
 * @param options - Extraction options
 * @returns Extracted errors with usage and cost information
 *
 * @example
 * ```ts
 * import { extractErrors } from "@detent/extract";
 *
 * const result = await extractErrors(ciLogs);
 * console.log(`Found ${result.errors.length} errors`);
 * console.log(`Cost: $${result.costUsd}`);
 * ```
 */
export const extractErrors = async (
  content: string,
  options?: ExtractionOptions
): Promise<ExtractionResult> => {
  const modelName = options?.model ?? DEFAULT_FAST_MODEL;

  // Validate and normalize model ID with helpful error context
  let modelId: string;
  try {
    modelId = normalizeModelId(modelName);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown normalization error";
    throw new Error(
      `Invalid model ID: ${modelName}. Expected format: provider/model-name or claude-*/gpt-* shorthand. ${message}`
    );
  }

  // Additional validation: ensure model ID has expected structure after normalization
  if (!modelId || typeof modelId !== "string" || modelId.trim() === "") {
    throw new Error(
      `Invalid model ID: ${modelName}. Expected format: provider/model-name or claude-*/gpt-* shorthand`
    );
  }

  const model = resolveModel(modelId, options?.apiKey);
  const maxOutputTokens = options?.maxOutputTokens ?? 4096;
  const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxContentLength = options?.maxContentLength ?? 15_000;

  // Prepare content: compact, sanitize, truncate
  // Truncation is determined after compaction, so a 20KB input that compacts
  // to 10KB won't be marked as truncated since all meaningful content was kept
  const { content: prepared, truncated } = prepareForPrompt(
    content,
    maxContentLength
  );

  // Empty content check
  if (!prepared.trim()) {
    return createEmptyResult(truncated);
  }

  // Content that was only injection attempts now contains only [FILTERED] markers
  // Skip AI processing for such content to avoid wasting tokens
  if (FILTERED_ONLY_PATTERN.test(prepared)) {
    return createEmptyResult(truncated);
  }

  // Combine user-provided abort signal with timeout
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal = options?.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const { object, usage } = await generateObject({
      model,
      schema: ExtractionResultSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildUserPrompt(prepared),
      maxOutputTokens,
      abortSignal,
    });

    // Calculate usage and cost
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const extractionUsage: ExtractionUsage = {
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    };
    const costUsd = estimateCost(modelId, inputTokens, outputTokens);

    return {
      errors: object.errors,
      detectedSource: object.detectedSource,
      usage: extractionUsage,
      costUsd,
      truncated,
    };
  } catch (error) {
    // Return empty result on extraction failure
    if (NoObjectGeneratedError.isInstance(error)) {
      return createEmptyResult(truncated);
    }
    throw new Error(
      `AI extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};
