import { z } from "zod";

const MAX_CONTEXT_VALUE_CHARS = 160;
const MAX_COMMAND_CHARS = 240;
const MAX_EXTERNAL_URL_CHARS = 500;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;
const MAX_DIAGNOSTIC_SOURCE_CHARS = 80;
const MAX_DIAGNOSTIC_RULE_ID_CHARS = 120;
const MAX_DIAGNOSTIC_FILE_PATH_CHARS = 240;
const MAX_DIAGNOSTIC_EVIDENCE_CHARS = 500;
const MAX_RELATED_ISSUE_TITLE_CHARS = 120;
const MAX_RELATED_ISSUE_SUMMARY_CHARS = 320;
const MAX_RELATED_ISSUE_MATCH_REASON_CHARS = 180;

export const issueSeverityValues = ["important", "medium", "low"] as const;
export const issueStatusValues = ["open", "resolved", "ignored"] as const;
export const observationSourceKindValues = [
  "manual-log",
  "ci",
  "runtime-log",
  "dev-server",
  "sentry",
] as const;
export const issueCategoryValues = [
  "type-check",
  "lint",
  "test",
  "compile",
  "runtime",
  "dependency",
  "config",
  "infrastructure",
  "security",
  "unknown",
] as const;
export const issueEnvironmentValues = [
  "local",
  "ci",
  "preview",
  "production",
  "unknown",
] as const;
export const issueDiagnosticSeverityValues = ["error", "warning"] as const;

export const IssueSeveritySchema = z.enum(issueSeverityValues);
export const IssueStatusSchema = z.enum(issueStatusValues);
export const ObservationSourceKindSchema = z.enum(observationSourceKindValues);
export const IssueCategorySchema = z.enum(issueCategoryValues);
export const IssueEnvironmentSchema = z.enum(issueEnvironmentValues);
export const IssueDiagnosticSeveritySchema = z.enum(
  issueDiagnosticSeverityValues
);

export const IssueObservationContextSchema = z.object({
  repo: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  app: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  service: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  environment: IssueEnvironmentSchema.default("unknown"),
  branch: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  commitSha: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  command: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
  route: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
  provider: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  externalId: z.string().trim().min(1).max(MAX_CONTEXT_VALUE_CHARS).optional(),
  externalUrl: z
    .string()
    .trim()
    .min(1)
    .max(MAX_EXTERNAL_URL_CHARS)
    .url()
    .optional(),
});

export const IssuePlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)),
  blockers: z.array(z.string().min(1)),
});

export const IssueDiagnosticSeedSchema = z.object({
  message: z.string().min(1).max(MAX_DIAGNOSTIC_MESSAGE_CHARS),
  severity: IssueDiagnosticSeveritySchema.nullable().optional(),
  category: z.string().max(MAX_CONTEXT_VALUE_CHARS).nullable().optional(),
  source: z.string().max(MAX_DIAGNOSTIC_SOURCE_CHARS).nullable().optional(),
  ruleId: z.string().max(MAX_DIAGNOSTIC_RULE_ID_CHARS).nullable().optional(),
  filePath: z
    .string()
    .max(MAX_DIAGNOSTIC_FILE_PATH_CHARS)
    .nullable()
    .optional(),
  line: z.number().int().nullable().optional(),
  column: z.number().int().nullable().optional(),
  evidence: z.string().max(MAX_DIAGNOSTIC_EVIDENCE_CHARS).nullable().optional(),
});

export const IssueDiagnosticDraftSchema = z.object({
  fingerprint: z.string().min(1),
  repoFingerprint: z.string().min(1),
  loreFingerprint: z.string().min(1),
  message: z.string().min(1).max(MAX_DIAGNOSTIC_MESSAGE_CHARS),
  severity: IssueDiagnosticSeveritySchema.nullable(),
  category: IssueCategorySchema.nullable(),
  source: z.string().max(MAX_DIAGNOSTIC_SOURCE_CHARS).nullable(),
  ruleId: z.string().max(MAX_DIAGNOSTIC_RULE_ID_CHARS).nullable(),
  filePath: z.string().max(MAX_DIAGNOSTIC_FILE_PATH_CHARS).nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  evidence: z.string().min(1).max(MAX_DIAGNOSTIC_EVIDENCE_CHARS),
});

export const IssueObservationDraftSchema = z.object({
  sourceKind: ObservationSourceKindSchema,
  rawText: z.string().optional(),
  rawPayload: z.unknown().optional(),
  dedupeKey: z.string().trim().min(1).max(255).optional(),
  context: IssueObservationContextSchema,
  capturedAt: z.date(),
  wasRedacted: z.boolean(),
  wasTruncated: z.boolean(),
  diagnostics: z.array(IssueDiagnosticDraftSchema),
});

export const LogSegmentSchema = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1),
  signal: z.boolean(),
});

export const IssueExtractionUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});

export const IssueExtractionMetricsSchema = z.object({
  originalLength: z.number().int().min(0),
  afterPreprocessLength: z.number().int().min(0),
  truncatedChars: z.number().int().min(0),
  noiseRatio: z.number().min(0),
});

export const IssueExtractionResultSchema = z.object({
  diagnostics: z.array(IssueDiagnosticDraftSchema).max(100),
  usage: IssueExtractionUsageSchema.optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
  truncated: z.boolean(),
  segmentsTruncated: z.boolean(),
  segments: z.array(LogSegmentSchema).optional(),
  metrics: IssueExtractionMetricsSchema.optional(),
});

export const RelatedIssueMemorySchema = z.object({
  title: z.string().min(1).max(MAX_RELATED_ISSUE_TITLE_CHARS),
  summary: z.string().min(1).max(MAX_RELATED_ISSUE_SUMMARY_CHARS),
  matchReason: z.string().min(1).max(MAX_RELATED_ISSUE_MATCH_REASON_CHARS),
  status: IssueStatusSchema,
  severity: IssueSeveritySchema,
});

export const IssueObservationMemorySchema = z.object({
  sourceKind: ObservationSourceKindSchema,
  context: IssueObservationContextSchema,
});

export const IssueSnapshotDraftSchema = z.object({
  title: z.string().min(1).max(120),
  severity: IssueSeveritySchema,
  summary: z.string().min(1).max(320),
  rootCause: z.string().max(400).nullable(),
  plan: z.object({
    summary: z.string().min(1).max(220),
    steps: z.array(z.string().min(1).max(180)).max(4),
    validation: z.array(z.string().min(1).max(180)).max(4),
    blockers: z.array(z.string().min(1).max(180)).max(4),
  }),
});

export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type ObservationSourceKind = z.infer<typeof ObservationSourceKindSchema>;
export type IssueCategory = z.infer<typeof IssueCategorySchema>;
export type IssueEnvironment = z.infer<typeof IssueEnvironmentSchema>;
export type IssueObservationContext = z.infer<
  typeof IssueObservationContextSchema
>;
export type IssuePlan = z.infer<typeof IssuePlanSchema>;
export type IssueDiagnosticSeed = z.infer<typeof IssueDiagnosticSeedSchema>;
export type IssueDiagnosticDraft = z.infer<typeof IssueDiagnosticDraftSchema>;
export type IssueObservationDraft = z.infer<typeof IssueObservationDraftSchema>;
export type LogSegment = z.infer<typeof LogSegmentSchema>;
export type IssueExtractionUsage = z.infer<typeof IssueExtractionUsageSchema>;
export type IssueExtractionMetrics = z.infer<
  typeof IssueExtractionMetricsSchema
>;
export type IssueExtractionResult = z.infer<typeof IssueExtractionResultSchema>;
export type RelatedIssueMemory = z.infer<typeof RelatedIssueMemorySchema>;
export type IssueObservationMemory = z.infer<
  typeof IssueObservationMemorySchema
>;
export type IssueSnapshotDraft = z.infer<typeof IssueSnapshotDraftSchema>;
