import type { CIError, ErrorSource } from "@detent/types";
import { CIErrorSchema, ErrorSourceSchema } from "@detent/types";
import { z } from "zod";

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ExtractionResult {
  errors: CIError[];
  detectedSource: ErrorSource | null;
  usage?: ExtractionUsage;
  costUsd?: number;
  truncated: boolean;
}

export const ExtractionResultSchema = z.object({
  errors: z.array(CIErrorSchema).describe("All extracted errors and warnings"),
  detectedSource: ErrorSourceSchema.nullable().describe(
    "The primary tool that produced the output, if identifiable"
  ),
});

export type ExtractionResultSchemaType = z.infer<typeof ExtractionResultSchema>;

export type OnErrorCallback = (error: CIError) => Promise<void>;

export interface ToolExtractionOptions {
  model?: string;
  maxOutputTokens?: number;
  timeout?: number;
  abortSignal?: AbortSignal;
  maxContentLength?: number;
  apiKey?: string;
  onError?: OnErrorCallback;
  maxErrors?: number;
}
