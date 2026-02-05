import type { CIError, ErrorSource } from "@detent/types";
import { CIErrorSchema, ErrorSourceSchema } from "@detent/types";
import { z } from "zod";

/**
 * Token usage from AI extraction.
 */
export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Result of AI error extraction.
 */
export interface ExtractionResult {
  /** Extracted errors */
  errors: CIError[];
  /** Detected tool/source if identifiable */
  detectedSource: ErrorSource | null;
  /** Token usage */
  usage?: ExtractionUsage;
  /** Estimated cost in USD */
  costUsd?: number;
  /** Whether the input was truncated */
  truncated: boolean;
}

/**
 * Zod schema for the AI extraction output.
 * Used with generateObject for structured extraction.
 */
export const ExtractionResultSchema = z.object({
  errors: z.array(CIErrorSchema).describe("All extracted errors and warnings"),
  detectedSource: ErrorSourceSchema.nullable().describe(
    "The primary tool that produced the output, if identifiable"
  ),
});

export type ExtractionResultSchemaType = z.infer<typeof ExtractionResultSchema>;

/**
 * Callback invoked for each error as it's extracted.
 * Useful for streaming errors to a database or UI as they're found.
 */
export type OnErrorCallback = (error: CIError) => Promise<void>;

/**
 * Options for tool-based error extraction.
 */
export interface ToolExtractionOptions {
  /** Model to use (default: claude-haiku-4-5) */
  model?: string;
  /** Maximum output tokens (default: 8192) */
  maxOutputTokens?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Maximum content length to process (default: 15000) */
  maxContentLength?: number;
  /** AI Gateway API key */
  apiKey?: string;
  /** Called for each error as it's found - can write to DB here */
  onError?: OnErrorCallback;
  /** Maximum errors to extract (default: 200) */
  maxErrors?: number;
}
