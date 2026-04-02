/**
 * Shared CI/log diagnostic schema.
 * Used by extraction, lore fingerprinting, and legacy resolving flows.
 * Flows from extraction → enrichment.
 *
 * Usage:
 * - parsers populate: message, filePath, line, column, severity, ruleId, source
 * - AI extraction adds: category, stackTrace, hints, codeSnippet, fixable
 * - post-processing adds: relatedFiles (parsed from stackTrace)
 * - CI/job context enriches: workflowContext, workflowJob
 */
import { z } from "zod";

export const ErrorSeveritySchema = z.enum(["error", "warning"]);

export const ErrorCategorySchema = z.enum([
  "lint",
  "type-check",
  "test",
  "compile",
  "runtime",
  "metadata",
  "security",
  "dependency",
  "config",
  "infrastructure",
  "docs",
  "unknown",
]);

export const ErrorSourceSchema = z.enum([
  "biome",
  "eslint",
  "typescript",
  "go",
  "go-test",
  "python",
  "rust",
  "vitest",
  "docker",
  "nodejs",
  "metadata",
  "infrastructure",
  "github-annotations",
  "generic",
]);

const MAX_FILE_PATH_LENGTH = 1000;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_RAW_LENGTH = 50_000;
const MAX_STACK_TRACE_LENGTH = 20_000;
const MAX_HINT_LENGTH = 2000;
const MAX_HINTS_COUNT = 20;
const MAX_RULE_ID_LENGTH = 200;
const MAX_SNIPPET_LINE_LENGTH = 500;
const MAX_SNIPPET_LINES = 20;
const MAX_LANGUAGE_LENGTH = 50;
const MAX_WORKFLOW_FIELD_LENGTH = 200;
const MAX_LOG_LINE_NUMBER = 1_000_000;

export const CodeSnippetSchema = z.object({
  lines: z
    .array(z.string().max(MAX_SNIPPET_LINE_LENGTH))
    .max(MAX_SNIPPET_LINES)
    .describe("Lines of source code context"),
  startLine: z
    .number()
    .int()
    .min(1)
    .describe("First line number in snippet (1-indexed)"),
  errorLine: z
    .number()
    .int()
    .min(1)
    .describe("Position of error line within lines array (1-indexed)"),
  language: z
    .string()
    .max(MAX_LANGUAGE_LENGTH)
    .describe("Language identifier: go, typescript, python"),
});

export const WorkflowContextSchema = z.object({
  job: z
    .string()
    .max(MAX_WORKFLOW_FIELD_LENGTH)
    .optional()
    .describe("GitHub Actions job name"),
  step: z
    .string()
    .max(MAX_WORKFLOW_FIELD_LENGTH)
    .optional()
    .describe("GitHub Actions step name"),
  action: z
    .string()
    .max(MAX_WORKFLOW_FIELD_LENGTH)
    .optional()
    .describe("GitHub Actions action name"),
});

export const CIErrorSchema = z.object({
  // Core (always populated)
  message: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_LENGTH)
    .describe("Error or warning message"),

  // Location (parsers populate)
  filePath: z
    .string()
    .max(MAX_FILE_PATH_LENGTH)
    .optional()
    .describe("File path where error occurred"),
  line: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Line number (1-indexed, 0 = unknown/not applicable)"),
  column: z.number().int().min(0).optional().describe("Column number"),

  // CI log location (AI extracts)
  logLineStart: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_LINE_NUMBER)
    .optional()
    .describe("First line in CI output where this error appears (1-indexed)"),
  logLineEnd: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_LINE_NUMBER)
    .optional()
    .describe("Last line in CI output for this error (1-indexed)"),

  // Classification (AI/parsers populate)
  severity: ErrorSeveritySchema.optional().describe("error or warning"),
  category: ErrorCategorySchema.optional().describe(
    "lint, type-check, test, compile, runtime, etc."
  ),
  source: ErrorSourceSchema.optional().describe(
    "Tool that produced the error: eslint, typescript, vitest, cargo"
  ),
  ruleId: z
    .string()
    .max(MAX_RULE_ID_LENGTH)
    .optional()
    .describe("Rule code like TS2304, no-unused-vars, E0308"),

  // Context (AI extracts, action enriches)
  raw: z
    .string()
    .max(MAX_RAW_LENGTH)
    .optional()
    .describe("Raw tool output for context"),
  stackTrace: z
    .string()
    .max(MAX_STACK_TRACE_LENGTH)
    .optional()
    .describe("Stack trace for test/runtime errors"),
  codeSnippet: CodeSnippetSchema.optional().describe(
    "Source code context around error"
  ),
  hints: z
    .array(z.string().max(MAX_HINT_LENGTH))
    .max(MAX_HINTS_COUNT)
    .optional()
    .describe("Fix suggestions from tool"),

  // Metadata flags
  fixable: z.boolean().optional().describe("Tool can auto-fix this error"),

  // Related files (post-processed from stackTrace)
  relatedFiles: z
    .array(z.string().max(MAX_FILE_PATH_LENGTH))
    .max(10)
    .optional()
    .describe("Files mentioned in stack trace or error context"),

  // Workflow context (action adds)
  workflowContext: WorkflowContextSchema.optional().describe(
    "GitHub Actions context"
  ),
  workflowJob: z
    .string()
    .max(MAX_WORKFLOW_FIELD_LENGTH)
    .optional()
    .describe("Flattened job name for access"),
});

/**
 * CIErrorSchema with runtime validation for log line ranges.
 * Use this for parsing/validating external data.
 * Use plain CIErrorSchema for tool parameters and extending.
 */
export const CIErrorSchemaWithValidation = CIErrorSchema.refine(
  (error) => {
    // logLineEnd requires logLineStart to be present
    if (error.logLineEnd !== undefined && error.logLineStart === undefined) {
      return false;
    }
    // When both present, logLineEnd must be >= logLineStart
    if (error.logLineStart !== undefined && error.logLineEnd !== undefined) {
      return error.logLineEnd >= error.logLineStart;
    }
    return true;
  },
  {
    message:
      "logLineEnd requires logLineStart and must be >= logLineStart when both present",
    path: ["logLineEnd"],
  }
);

export type CIError = z.infer<typeof CIErrorSchema>;
export type CICodeSnippet = z.infer<typeof CodeSnippetSchema>;
export type CIWorkflowContext = z.infer<typeof WorkflowContextSchema>;
