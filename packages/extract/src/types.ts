import type { CIError, ErrorSource } from "@obsr/types";
import { CIErrorSchemaWithValidation, ErrorSourceSchema } from "@obsr/types";
import { z } from "zod";
import type { LogSegment } from "./preprocess.js";

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ExtractionMetrics {
  originalLength: number;
  afterPreprocessLength: number;
  truncatedChars: number;
  noiseRatio: number;
}

export interface ExtractionResult {
  errors: CIError[];
  detectedSource: ErrorSource | null;
  usage?: ExtractionUsage;
  costUsd?: number;
  model?: string;
  truncated: boolean;
  segmentsTruncated: boolean;
  segments?: LogSegment[];
  metrics?: ExtractionMetrics;
}

const LogSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  signal: z.boolean(),
});

export const ExtractionResultSchema = z.object({
  errors: z
    .array(CIErrorSchemaWithValidation)
    .max(100)
    .describe("All extracted errors and warnings"),
  detectedSource: ErrorSourceSchema.nullable().describe(
    "The primary tool that produced the output, if identifiable"
  ),
  truncated: z.boolean(),
  segmentsTruncated: z.boolean(),
  segments: z.array(LogSegmentSchema).optional(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  costUsd: z.number().optional(),
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
