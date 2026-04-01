import {
  ErrorCategorySchema,
  ErrorSeveritySchema,
  ErrorSourceSchema,
} from "@obsr/types";
import { z } from "zod";

export const InputKindSchema = z.enum(["paste"]);

export const AnalysisDiagnosticSchema = z.object({
  fingerprint: z.string().min(1),
  message: z.string().min(1),
  severity: ErrorSeveritySchema.nullable(),
  category: ErrorCategorySchema.nullable(),
  source: ErrorSourceSchema.nullable(),
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  ruleId: z.string().nullable(),
  evidence: z.string().min(1),
  rank: z.number().int().min(0),
});

export const AnalysisCreateInputSchema = z.object({
  inputKind: InputKindSchema.default("paste"),
  rawLog: z.string(),
});

export const AnalysisListItemSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  inputKind: InputKindSchema,
  summary: z.string(),
  diagnosticCount: z.number().int().min(0),
});

export const AnalysisDetailSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  inputKind: InputKindSchema,
  rawLogWasTruncated: z.boolean(),
  summary: z.string(),
  diagnosticCount: z.number().int().min(0),
  diagnostics: z.array(AnalysisDiagnosticSchema),
});

export const AnalysisCreateOutputSchema = AnalysisDetailSchema.extend({
  prompt: z.string().min(1),
});

export type InputKind = z.infer<typeof InputKindSchema>;
export type AnalysisDiagnostic = z.infer<typeof AnalysisDiagnosticSchema>;
export type AnalysisCreateInput = z.infer<typeof AnalysisCreateInputSchema>;
export type AnalysisListItem = z.infer<typeof AnalysisListItemSchema>;
export type AnalysisDetail = z.infer<typeof AnalysisDetailSchema>;
export type AnalysisCreateOutput = z.infer<typeof AnalysisCreateOutputSchema>;
