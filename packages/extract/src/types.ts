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
