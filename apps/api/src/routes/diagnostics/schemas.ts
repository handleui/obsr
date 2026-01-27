import { z } from "@hono/zod-openapi";

export const SeveritySchema = z.enum(["error", "warning"]).openapi("Severity");

export const DetectedToolSchema = z
  .enum(["eslint", "vitest", "typescript", "cargo", "golangci"])
  .openapi("DetectedTool");

export const ModeSchema = z.enum(["full", "lite"]).openapi("Mode");

export const DiagnosticsRequestSchema = z
  .object({
    content: z
      .string()
      .min(1, "content must not be empty")
      .max(10 * 1024 * 1024, "content exceeds maximum length of 10MB")
      .openapi({
        description: "Raw CI/build log content to parse",
        example: "src/app.ts:10:5 - error TS2304: Cannot find name 'foo'",
      }),
    tool: DetectedToolSchema.optional().openapi({
      description:
        "Hint for which tool produced the output. Auto-detected if omitted.",
    }),
    mode: ModeSchema.default("full").openapi({
      description:
        "Response detail level. 'full' includes severity, ruleId, suggestions. 'lite' is minimal.",
    }),
  })
  .openapi("DiagnosticsRequest");

export const DiagnosticSchema = z
  .object({
    message: z.string().openapi({
      description: "Error or warning message",
      example: "Cannot find name 'foo'",
    }),
    file_path: z.string().optional().openapi({
      description: "File path where the issue occurred",
      example: "src/app.ts",
    }),
    line: z.number().int().positive().optional().openapi({
      description: "Line number (1-indexed)",
      example: 10,
    }),
    column: z.number().int().positive().optional().openapi({
      description: "Column number (1-indexed)",
      example: 5,
    }),
    severity: SeveritySchema.openapi({
      description: "Issue severity level",
    }),
    rule_id: z.string().optional().openapi({
      description: "Tool-specific rule identifier",
      example: "TS2304",
    }),
    stack_trace: z.string().optional().openapi({
      description: "Stack trace if available (e.g., for test failures)",
    }),
    suggestions: z.array(z.string()).optional().openapi({
      description: "Suggested fixes from the tool",
    }),
    fixable: z.boolean().optional().openapi({
      description: "Whether the tool can auto-fix this issue",
    }),
  })
  .openapi("Diagnostic");

export const DiagnosticLiteSchema = z
  .object({
    message: z.string().openapi({
      description: "Error or warning message",
      example: "Cannot find name 'foo'",
    }),
    file_path: z.string().optional().openapi({
      description: "File path where the issue occurred",
      example: "src/app.ts",
    }),
    line: z.number().int().positive().optional().openapi({
      description: "Line number (1-indexed)",
      example: 10,
    }),
    column: z.number().int().positive().optional().openapi({
      description: "Column number (1-indexed)",
      example: 5,
    }),
  })
  .openapi("DiagnosticLite");

export const SummarySchema = z
  .object({
    total: z.number().int().openapi({
      description: "Total number of diagnostics",
      example: 5,
    }),
    errors: z.number().int().openapi({
      description: "Number of errors",
      example: 3,
    }),
    warnings: z.number().int().openapi({
      description: "Number of warnings",
      example: 2,
    }),
  })
  .openapi("DiagnosticSummary");

export const DiagnosticsResponseFullSchema = z
  .object({
    mode: z.literal("full").openapi({
      description: "Response mode indicator (discriminator)",
    }),
    detected_tool: z.string().nullable().openapi({
      description: "Tool detected from output (null if unknown)",
      example: "typescript",
    }),
    diagnostics: z.array(DiagnosticSchema).openapi({
      description: "Parsed diagnostics from the log",
    }),
    summary: SummarySchema.openapi({
      description: "Aggregated counts",
    }),
    truncated: z.boolean().openapi({
      description: "True if diagnostics were truncated (max 10,000)",
    }),
  })
  .openapi("DiagnosticsResponseFull");

export const DiagnosticsResponseLiteSchema = z
  .object({
    mode: z.literal("lite").openapi({
      description: "Response mode indicator (discriminator)",
    }),
    detected_tool: z.string().nullable().openapi({
      description: "Tool detected from output (null if unknown)",
      example: "typescript",
    }),
    diagnostics: z.array(DiagnosticLiteSchema).openapi({
      description: "Parsed diagnostics (minimal fields)",
    }),
    truncated: z.boolean().openapi({
      description: "True if diagnostics were truncated (max 10,000)",
    }),
  })
  .openapi("DiagnosticsResponseLite");

export const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({
      description: "Error message",
      example: "content must be a string",
    }),
  })
  .openapi("ErrorResponse");

export const RateLimitErrorSchema = z
  .object({
    error: z.string().openapi({
      description: "Rate limit error message",
      example: "Rate limit exceeded",
    }),
    retryAfter: z.number().int().openapi({
      description: "Unix timestamp when the rate limit resets",
      example: 1_706_300_000,
    }),
  })
  .openapi("RateLimitError");

export const DiagnosticsResponseSchema = z
  .discriminatedUnion("mode", [
    DiagnosticsResponseFullSchema,
    DiagnosticsResponseLiteSchema,
  ])
  .openapi("DiagnosticsResponse");
