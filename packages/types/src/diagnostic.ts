/**
 * Unified CI error schema.
 * Single source of truth for all error types across the monorepo.
 * Flows from extraction → healing.
 *
 * Usage:
 * - parsers populate: message, filePath, line, column, severity, ruleId, source
 * - AI extraction adds: category, stackTrace, hints, codeSnippet, fixable
 * - post-processing adds: relatedFiles (parsed from stackTrace)
 * - action enriches: workflowContext, workflowJob
 */
import { z } from "zod";

// =============================================================================
// Enum Schemas
// =============================================================================

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

// =============================================================================
// Validation Constants
// =============================================================================

/** Maximum file path length to prevent memory abuse */
const MAX_FILE_PATH_LENGTH = 1000;
/** Maximum error message length */
const MAX_MESSAGE_LENGTH = 10_000;
/** Maximum raw output length */
const MAX_RAW_LENGTH = 50_000;
/** Maximum stack trace length */
const MAX_STACK_TRACE_LENGTH = 20_000;
/** Maximum hint length */
const MAX_HINT_LENGTH = 2000;
/** Maximum hints per error */
const MAX_HINTS_COUNT = 20;
/** Maximum rule ID length */
const MAX_RULE_ID_LENGTH = 200;
/** Maximum code snippet line length */
const MAX_SNIPPET_LINE_LENGTH = 500;
/** Maximum lines in code snippet */
const MAX_SNIPPET_LINES = 20;
/** Maximum language identifier length */
const MAX_LANGUAGE_LENGTH = 50;
/** Maximum workflow field length */
const MAX_WORKFLOW_FIELD_LENGTH = 200;

// =============================================================================
// Composite Schemas
// =============================================================================

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

// =============================================================================
// Unified CI Error Schema
// =============================================================================

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

  /**
   * @deprecated Use workflowContext.step instead.
   * Retained for backward compatibility with existing DB records.
   */
  workflowStep: z
    .string()
    .max(MAX_WORKFLOW_FIELD_LENGTH)
    .optional()
    .describe("Legacy: GitHub Actions step name. Use workflowContext.step."),
});

// =============================================================================
// Inferred Types
// =============================================================================

export type CIError = z.infer<typeof CIErrorSchema>;
export type CICodeSnippet = z.infer<typeof CodeSnippetSchema>;
export type CIWorkflowContext = z.infer<typeof WorkflowContextSchema>;

/**
 * @deprecated Use CIError instead. This alias exists for backward compatibility.
 */
export type ExtractedError = CIError;

/**
 * @deprecated Use CIError instead. Mutable variant for error builders.
 */
export type MutableExtractedError = CIError;

/**
 * @deprecated Use CIError instead.
 */
export type DiagnosticError = CIError;
