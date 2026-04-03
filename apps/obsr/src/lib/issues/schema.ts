import {
  IssueCategorySchema as SharedIssueCategorySchema,
  IssueObservationContextSchema as SharedIssueObservationContextSchema,
  IssuePlanSchema as SharedIssuePlanSchema,
  IssueSeveritySchema as SharedIssueSeveritySchema,
  IssueStatusSchema as SharedIssueStatusSchema,
  ObservationSourceKindSchema as SharedObservationSourceKindSchema,
  issueDiagnosticSeverityValues as sharedIssueDiagnosticSeverityValues,
} from "@obsr/issues";
import { z } from "zod";
import { MAX_RAW_TEXT_CHARS } from "./constants";

export type {
  IssueCategory,
  IssueEnvironment,
  IssueObservationContext,
  IssuePlan,
  IssueSeverity,
  IssueStatus,
  ObservationSourceKind,
} from "@obsr/issues";
// biome-ignore lint/performance/noBarrelFile: ObsR keeps shared issue contracts behind this local schema surface.
export {
  IssueCategorySchema,
  IssueEnvironmentSchema,
  IssueObservationContextSchema,
  IssuePlanSchema,
  IssueSeveritySchema,
  IssueStatusSchema,
  issueCategoryValues,
  issueDiagnosticSeverityValues,
  issueEnvironmentValues,
  issueSeverityValues,
  issueStatusValues,
  ObservationSourceKindSchema,
  observationSourceKindValues,
} from "@obsr/issues";

export const IssueObservationSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  sourceKind: SharedObservationSourceKindSchema,
  rawText: z.string().optional(),
  rawPayload: z.unknown().optional(),
  context: SharedIssueObservationContextSchema,
  capturedAt: z.string().datetime(),
  wasRedacted: z.boolean(),
  wasTruncated: z.boolean(),
});

export const RelatedIssueSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  status: SharedIssueStatusSchema,
  severity: SharedIssueSeveritySchema,
  summary: z.string().min(1),
  lastSeenAt: z.string().datetime(),
  matchReason: z.string().min(1),
});

export const IssueObservationViewSchema = IssueObservationSchema.omit({
  rawPayload: true,
  rawText: true,
});

export const IssueDiagnosticSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  observationId: z.string(),
  fingerprint: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(sharedIssueDiagnosticSeverityValues).nullable(),
  category: SharedIssueCategorySchema.nullable(),
  source: z.string().nullable(),
  ruleId: z.string().nullable(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  evidence: z.string().min(1),
});

export const IssueSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  severity: SharedIssueSeveritySchema,
  status: SharedIssueStatusSchema,
  primaryCategory: SharedIssueCategorySchema.nullable(),
  primarySourceKind: SharedObservationSourceKindSchema.nullable(),
  sourceKinds: z.array(SharedObservationSourceKindSchema),
  summary: z.string().min(1),
  rootCause: z.string().nullable(),
  plan: SharedIssuePlanSchema,
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  observationCount: z.number().int().min(0),
  diagnosticCount: z.number().int().min(0),
});

export const IssueListItemSchema = IssueSchema.pick({
  id: true,
  title: true,
  severity: true,
  status: true,
  primaryCategory: true,
  primarySourceKind: true,
  sourceKinds: true,
  summary: true,
  lastSeenAt: true,
  observationCount: true,
  diagnosticCount: true,
});

export const IssueDetailSchema = IssueSchema.extend({
  observations: z.array(IssueObservationSchema),
  diagnostics: z.array(IssueDiagnosticSchema),
  relatedIssues: z.array(RelatedIssueSchema),
  brief: z.string().min(1),
});

export const IssueDetailViewSchema = IssueSchema.extend({
  observations: z.array(IssueObservationViewSchema),
  diagnostics: z.array(IssueDiagnosticSchema),
  relatedIssues: z.array(RelatedIssueSchema),
  brief: z.string().min(1),
});

export const IssueCreatedSchema = z.object({
  id: z.string().min(1),
});

export const IssueIngestInputSchema = z
  .object({
    sourceKind: SharedObservationSourceKindSchema.default("manual-log"),
    rawText: z.string().max(MAX_RAW_TEXT_CHARS).optional(),
    rawPayload: z.unknown().optional(),
    dedupeKey: z.string().trim().min(1).max(255).optional(),
    capturedAt: z.string().datetime().optional(),
    context: SharedIssueObservationContextSchema.default({
      environment: "unknown",
    }),
  })
  .superRefine((input, ctx) => {
    const needsPayload = input.sourceKind === "sentry";

    if (needsPayload && input.rawPayload === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rawPayload is required for sentry observations.",
        path: ["rawPayload"],
      });
    }

    if (!(needsPayload || input.rawText?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rawText is required for log-based observations.",
        path: ["rawText"],
      });
    }
  });

export const IssueIngestOutputSchema = IssueDetailSchema;
export type IssueObservation = z.infer<typeof IssueObservationSchema>;
export type IssueObservationView = z.infer<typeof IssueObservationViewSchema>;
export type IssueDiagnostic = z.infer<typeof IssueDiagnosticSchema>;
export type RelatedIssue = z.infer<typeof RelatedIssueSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type IssueListItem = z.infer<typeof IssueListItemSchema>;
export type IssueDetail = z.infer<typeof IssueDetailSchema>;
export type IssueDetailView = z.infer<typeof IssueDetailViewSchema>;
export type IssueCreated = z.infer<typeof IssueCreatedSchema>;
export type IssueIngestInput = z.infer<typeof IssueIngestInputSchema>;
export type IssueIngestOutput = z.infer<typeof IssueIngestOutputSchema>;
