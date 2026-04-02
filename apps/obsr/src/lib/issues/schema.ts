import { z } from "zod";
import { MAX_RAW_TEXT_CHARS } from "./constants";

export const IssueSeveritySchema = z.enum(["important", "medium", "low"]);
export const IssueStatusSchema = z.enum(["open", "resolved", "ignored"]);
export const ObservationSourceKindSchema = z.enum([
  "manual-log",
  "ci",
  "runtime-log",
  "dev-server",
  "sentry",
]);
export const IssueCategorySchema = z.enum([
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
]);
export const IssueEnvironmentSchema = z.enum([
  "local",
  "ci",
  "preview",
  "production",
  "unknown",
]);

export const IssueObservationContextSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  app: z.string().trim().min(1).optional(),
  service: z.string().trim().min(1).optional(),
  environment: IssueEnvironmentSchema.default("unknown"),
  branch: z.string().trim().min(1).optional(),
  commitSha: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1).optional(),
  route: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  externalId: z.string().trim().min(1).optional(),
  externalUrl: z.string().trim().url().optional(),
});

export const IssuePlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)),
  blockers: z.array(z.string().min(1)),
});

export const IssueObservationSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  sourceKind: ObservationSourceKindSchema,
  rawText: z.string().optional(),
  rawPayload: z.unknown().optional(),
  context: IssueObservationContextSchema,
  capturedAt: z.string().datetime(),
  wasRedacted: z.boolean(),
  wasTruncated: z.boolean(),
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
  severity: z.enum(["error", "warning"]).nullable(),
  category: IssueCategorySchema.nullable(),
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
  severity: IssueSeveritySchema,
  status: IssueStatusSchema,
  primaryCategory: IssueCategorySchema.nullable(),
  primarySourceKind: ObservationSourceKindSchema.nullable(),
  sourceKinds: z.array(ObservationSourceKindSchema),
  summary: z.string().min(1),
  rootCause: z.string().nullable(),
  plan: IssuePlanSchema,
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
  brief: z.string().min(1),
});

export const IssueDetailViewSchema = IssueSchema.extend({
  observations: z.array(IssueObservationViewSchema),
  diagnostics: z.array(IssueDiagnosticSchema),
  brief: z.string().min(1),
});

export const IssueCreatedSchema = z.object({
  id: z.string().min(1),
});

export const IssueIngestInputSchema = z
  .object({
    sourceKind: ObservationSourceKindSchema.default("manual-log"),
    rawText: z.string().max(MAX_RAW_TEXT_CHARS).optional(),
    rawPayload: z.unknown().optional(),
    context: IssueObservationContextSchema.default({
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

export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type ObservationSourceKind = z.infer<typeof ObservationSourceKindSchema>;
export type IssueCategory = z.infer<typeof IssueCategorySchema>;
export type IssueEnvironment = z.infer<typeof IssueEnvironmentSchema>;
export type IssueObservationContext = z.infer<
  typeof IssueObservationContextSchema
>;
export type IssuePlan = z.infer<typeof IssuePlanSchema>;
export type IssueObservation = z.infer<typeof IssueObservationSchema>;
export type IssueObservationView = z.infer<typeof IssueObservationViewSchema>;
export type IssueDiagnostic = z.infer<typeof IssueDiagnosticSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type IssueListItem = z.infer<typeof IssueListItemSchema>;
export type IssueDetail = z.infer<typeof IssueDetailSchema>;
export type IssueDetailView = z.infer<typeof IssueDetailViewSchema>;
export type IssueCreated = z.infer<typeof IssueCreatedSchema>;
export type IssueIngestInput = z.infer<typeof IssueIngestInputSchema>;
export type IssueIngestOutput = z.infer<typeof IssueIngestOutputSchema>;
