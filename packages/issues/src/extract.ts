import {
  createStructuredResponse,
  handleResponsesError,
  type ResponsesRuntimeOptions,
  zodTextFormat,
} from "@obsr/ai";
import { z } from "zod";
import { createIssueDiagnosticDraft } from "./normalize.js";
import { type LogSegment, prepareForPrompt } from "./preprocess.js";
import {
  buildIssueExtractionPrompt,
  ISSUE_EXTRACTION_SYSTEM_PROMPT,
} from "./prompt.js";
import {
  type IssueDiagnosticDraft,
  type IssueExtractionMetrics,
  type IssueExtractionResult,
  IssueExtractionResultSchema,
  type IssueExtractionUsage,
} from "./schema.js";

const FILTERED_ONLY_PATTERN = /^\s*(?:\[FILTERED\]\s*)+$/;

const RawIssueDiagnosticSchema = z.object({
  message: z.string().min(1),
  severity: z.enum(["error", "warning"]).nullable(),
  category: z.string().nullable(),
  source: z.string().nullable(),
  ruleId: z.string().nullable(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  evidence: z.string().nullable(),
});

const RawIssueExtractionSchema = z.object({
  diagnostics: z.array(RawIssueDiagnosticSchema).max(100),
});

const ISSUE_EXTRACTION_TEXT_FORMAT = zodTextFormat(
  RawIssueExtractionSchema,
  "issue_extraction"
);
const DEFAULT_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS = 1200;

export interface ExtractionOptions extends ResponsesRuntimeOptions {
  maxContentLength?: number;
}

const createEmptyResult = (
  truncated: boolean,
  segmentsTruncated: boolean,
  segments?: LogSegment[],
  metrics?: IssueExtractionMetrics
): IssueExtractionResult => ({
  diagnostics: [],
  truncated,
  segmentsTruncated,
  segments,
  metrics,
});

interface PreparedExtraction {
  prepared: string;
  truncated: boolean;
  segmentsTruncated: boolean;
  segments: LogSegment[];
  metrics: IssueExtractionMetrics;
  empty: false;
}

interface EmptyExtraction {
  truncated: boolean;
  segmentsTruncated: boolean;
  segments: LogSegment[];
  metrics: IssueExtractionMetrics;
  empty: true;
}

const prepareExtraction = (
  content: string,
  options: Pick<ExtractionOptions, "maxContentLength">
): PreparedExtraction | EmptyExtraction => {
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

  return {
    prepared,
    truncated,
    segmentsTruncated,
    segments,
    metrics,
    empty: false,
  };
};

const mapDiagnostics = (
  diagnostics: z.infer<typeof RawIssueDiagnosticSchema>[]
) => {
  return diagnostics.map((diagnostic) =>
    createIssueDiagnosticDraft({
      message: diagnostic.message,
      severity: diagnostic.severity,
      category: diagnostic.category,
      source: diagnostic.source,
      ruleId: diagnostic.ruleId,
      filePath: diagnostic.filePath,
      line: diagnostic.line,
      column: diagnostic.column,
      evidence: diagnostic.evidence,
    })
  );
};

const buildResult = ({
  diagnostics,
  usage,
  costUsd,
  model,
  truncated,
  segmentsTruncated,
  segments,
  metrics,
}: {
  diagnostics: IssueDiagnosticDraft[];
  usage?: IssueExtractionUsage;
  costUsd?: number;
  model?: string;
  truncated: boolean;
  segmentsTruncated: boolean;
  segments?: LogSegment[];
  metrics?: IssueExtractionMetrics;
}) => {
  return IssueExtractionResultSchema.parse({
    diagnostics,
    usage,
    costUsd,
    model,
    truncated,
    segmentsTruncated,
    segments,
    metrics,
  });
};

export const extractIssueDiagnostics = async (
  content: string,
  options: ExtractionOptions
): Promise<IssueExtractionResult> => {
  const prep = prepareExtraction(content, options);
  if (prep.empty) {
    return createEmptyResult(
      prep.truncated,
      prep.segmentsTruncated,
      prep.segments,
      prep.metrics
    );
  }

  try {
    const result = await createStructuredResponse({
      options: {
        ...options,
        model: options.model ?? DEFAULT_EXTRACTION_MODEL,
        maxOutputTokens:
          options.maxOutputTokens ?? DEFAULT_EXTRACTION_MAX_OUTPUT_TOKENS,
        reasoningEffort: options.reasoningEffort ?? "minimal",
      },
      request: {
        system: ISSUE_EXTRACTION_SYSTEM_PROMPT,
        prompt: buildIssueExtractionPrompt(prep.prepared),
        textFormat: ISSUE_EXTRACTION_TEXT_FORMAT,
      },
    });

    if (!result.parsed) {
      return createEmptyResult(
        prep.truncated,
        prep.segmentsTruncated,
        prep.segments,
        prep.metrics
      );
    }

    return buildResult({
      diagnostics: mapDiagnostics(result.parsed.diagnostics),
      usage: result.usage.usage,
      costUsd: result.usage.costUsd,
      model: result.modelId,
      truncated: prep.truncated,
      segmentsTruncated: prep.segmentsTruncated,
      segments: prep.segments,
      metrics: prep.metrics,
    });
  } catch (error) {
    return handleResponsesError(error, "Issue extraction failed");
  }
};
