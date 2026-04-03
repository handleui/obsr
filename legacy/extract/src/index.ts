import type {
  IssueDiagnosticDraft,
  IssueExtractionMetrics,
  IssueExtractionUsage,
  LogSegment,
} from "@obsr/issues";
import {
  extractIssueDiagnostics,
  type ExtractionOptions as IssueExtractionOptions,
} from "@obsr/issues";
import type { CIError, ErrorSource } from "@obsr/legacy-types";

export type ExtractionOptions = IssueExtractionOptions;
export type ExtractionUsage = IssueExtractionUsage;
export type ExtractionMetrics = IssueExtractionMetrics;
export type { LogSegment } from "@obsr/issues";

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

const toLegacyErrorSource = (value: string | null): ErrorSource | null => {
  if (!value) {
    return null;
  }

  return value as ErrorSource;
};

const toLegacyError = (diagnostic: IssueDiagnosticDraft): CIError => {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity ?? undefined,
    category: diagnostic.category ?? undefined,
    source: toLegacyErrorSource(diagnostic.source) ?? undefined,
    ruleId: diagnostic.ruleId ?? undefined,
    filePath: diagnostic.filePath ?? undefined,
    line: diagnostic.line ?? undefined,
    column: diagnostic.column ?? undefined,
    raw: diagnostic.evidence,
  };
};

const detectPrimarySource = (errors: CIError[]): ErrorSource | null => {
  return errors.find((error) => error.source)?.source ?? null;
};

export const extractErrors = async (
  content: string,
  options?: ExtractionOptions
): Promise<ExtractionResult> => {
  const result = await extractIssueDiagnostics(
    content,
    options ?? { apiKey: "" }
  );
  const errors = result.diagnostics.map(toLegacyError);

  return {
    errors,
    detectedSource: detectPrimarySource(errors),
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    truncated: result.truncated,
    segmentsTruncated: result.segmentsTruncated,
    segments: result.segments,
    metrics: result.metrics,
  };
};
