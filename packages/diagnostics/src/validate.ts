import { generateObject } from "ai";
import { z } from "zod";
import type { Diagnostic, DiagnosticResult } from "./types.js";

/**
 * Confidence level for validation results.
 */
export type Confidence = "high" | "medium" | "low";

/**
 * Validation status for each diagnostic.
 */
export type ValidationStatus = "confirmed" | "false_positive" | "uncertain";

/**
 * A diagnostic with validation metadata from the LLM review.
 */
export interface ValidatedDiagnostic extends Diagnostic {
  /** Validation status after LLM review */
  validation: ValidationStatus;
  /** Confidence in the validation */
  confidence: Confidence;
  /** Reason for the validation decision */
  reason?: string;
}

/**
 * A diagnostic that was missed by the parser but found by validation.
 */
export interface MissedDiagnostic {
  message: string;
  filePath?: string;
  line?: number;
  severity?: "error" | "warning";
  /** Why the parser might have missed this */
  missedReason: string;
}

/**
 * Result of the validation pass.
 */
export interface ValidationResult {
  /** Original diagnostics with validation metadata */
  validated: ValidatedDiagnostic[];
  /** Diagnostics found by validation but missed by parser */
  missed: MissedDiagnostic[];
  /** Summary of validation results */
  summary: {
    total: number;
    confirmed: number;
    falsePositives: number;
    uncertain: number;
    missed: number;
  };
}

/**
 * Options for validation.
 */
export interface ValidateOptions {
  /** Model to use for validation (default: claude-haiku-4-5) */
  model?: string;
  /** Maximum output tokens for the response */
  maxOutputTokens?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

// CI noise patterns to filter out
const NOISE_PATTERNS = [
  /^\s*$/,
  /^[-=]{3,}$/,
  /^\s*\d+\s+passing/i,
  /^\s*\d+\s+pending/i,
  /^npm\s+(warn|notice)/i,
  /^yarn\s+(warn|notice)/i,
  /^\s*at\s+(?:Object\.|Module\.|Function\.)/,
  /^\s*at\s+node:/,
  /^\s*at\s+internal\//,
  /^Downloading/i,
  /^Installing/i,
  /^Resolving/i,
  /^\s*\^+\s*$/,
  /^\s*~+\s*$/,
];

// Patterns that indicate important lines (keep these)
const IMPORTANT_PATTERNS = [
  /error/i,
  /warning/i,
  /failed/i,
  /failure/i,
  /exception/i,
  /:\d+:\d+/,
  /line\s+\d+/i,
  /^\s*>\s+\d+\s*\|/,
  /FAIL|PASS|ERROR|WARN/,
];

/**
 * Compacts CI output by removing noise while preserving errors.
 */
export const compactCiOutput = (content: string): string => {
  const lines = content.split("\n");
  const result: string[] = [];
  let consecutiveNoiseCount = 0;

  for (const line of lines) {
    const isNoise = NOISE_PATTERNS.some((p) => p.test(line));
    const isImportant = IMPORTANT_PATTERNS.some((p) => p.test(line));

    if (isImportant || !isNoise) {
      if (consecutiveNoiseCount > 3) {
        result.push(`... [${consecutiveNoiseCount} lines omitted]`);
      }
      consecutiveNoiseCount = 0;
      result.push(line);
    } else {
      consecutiveNoiseCount++;
    }
  }

  if (consecutiveNoiseCount > 3) {
    result.push(`... [${consecutiveNoiseCount} lines omitted]`);
  }

  return result.join("\n");
};

/**
 * Truncates content for the prompt to avoid excessive token usage.
 */
const truncateContent = (content: string, maxLength = 15_000): string => {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... [truncated, ${content.length - maxLength} more characters]`;
};

/**
 * Formats diagnostics for the prompt.
 */
const formatDiagnosticsForPrompt = (diagnostics: Diagnostic[]): string => {
  if (diagnostics.length === 0) {
    return "(none)";
  }

  return diagnostics
    .map((d, i) => {
      const location = d.filePath
        ? `${d.filePath}${d.line ? `:${d.line}` : ""}${d.column ? `:${d.column}` : ""}`
        : "(no location)";
      return `[${i + 1}] ${d.severity ?? "unknown"}: ${d.message}\n    at ${location}${d.ruleId ? ` (${d.ruleId})` : ""}`;
    })
    .join("\n");
};

/**
 * Zod schema for structured validation output.
 */
const validationSchema = z.object({
  validated: z
    .array(
      z.object({
        index: z.number().describe("1-based index of the diagnostic"),
        status: z
          .enum(["confirmed", "false_positive", "uncertain"])
          .describe("Validation status"),
        confidence: z
          .enum(["high", "medium", "low"])
          .describe("Confidence level"),
        reason: z.string().optional().describe("Reason if not confirmed"),
      })
    )
    .describe("Validation results for each parsed diagnostic"),
  missed: z
    .array(
      z.object({
        message: z.string().describe("Error message found in CI output"),
        filePath: z.string().optional().describe("File path if identifiable"),
        line: z.number().optional().describe("Line number if identifiable"),
        severity: z
          .enum(["error", "warning"])
          .optional()
          .describe("Severity level"),
        missedReason: z
          .string()
          .describe("Why the parser might have missed this"),
      })
    )
    .describe("Errors found in CI output but missed by parser"),
});

const SYSTEM_PROMPT = `You are a CI output validation expert. Your job is to verify that parsed diagnostics accurately reflect the actual CI output.

Guidelines:
- Mark as "confirmed" if the diagnostic correctly represents an error/warning in the CI output
- Mark as "false_positive" if the diagnostic doesn't exist in the output or is misinterpreted
- Mark as "uncertain" if you cannot determine with confidence
- Only report "missed" errors that are clearly actionable (not informational messages)
- Be concise in reasons`;

const buildUserPrompt = (
  rawOutput: string,
  detectedTool: string | null,
  diagnostics: string
): string => `## CI Output (${detectedTool ?? "unknown"} tool)
<ci_output>
${rawOutput}
</ci_output>

## Parsed Diagnostics
${diagnostics}

Validate each diagnostic against the CI output. Identify any missed errors.`;

/**
 * Maps generateObject output to ValidationResult.
 */
const mapToResult = (
  diagnostics: Diagnostic[],
  object: z.infer<typeof validationSchema>
): ValidationResult => {
  const validated: ValidatedDiagnostic[] = diagnostics.map((diag, i) => {
    const validation = object.validated.find((v) => v.index === i + 1);
    return {
      ...diag,
      validation: validation?.status ?? "uncertain",
      confidence: validation?.confidence ?? "low",
      reason: validation?.reason,
    };
  });

  const summary = {
    total: validated.length,
    confirmed: validated.filter((v) => v.validation === "confirmed").length,
    falsePositives: validated.filter((v) => v.validation === "false_positive")
      .length,
    uncertain: validated.filter((v) => v.validation === "uncertain").length,
    missed: object.missed.length,
  };

  return { validated, missed: object.missed, summary };
};

/**
 * Creates a fallback result when validation fails.
 */
const createFallbackResult = (diagnostics: Diagnostic[]): ValidationResult => {
  const validated: ValidatedDiagnostic[] = diagnostics.map((d) => ({
    ...d,
    validation: "uncertain" as const,
    confidence: "low" as const,
    reason: "Validation failed",
  }));

  return {
    validated,
    missed: [],
    summary: {
      total: validated.length,
      confirmed: 0,
      falsePositives: 0,
      uncertain: validated.length,
      missed: 0,
    },
  };
};

/**
 * Validates parsed diagnostics using an LLM to catch false positives and missed errors.
 *
 * Uses generateObject for structured output which is more reliable than JSON parsing.
 * CI output is automatically compacted to reduce noise and token usage.
 *
 * @param rawOutput - The original CI output
 * @param parseResult - The result from the parser
 * @param options - Validation options
 * @returns Validated diagnostics with confidence scores and missed errors
 *
 * @example
 * ```ts
 * import { extract, validate } from "@detent/diagnostics"
 *
 * const result = extract(ciOutput)
 * const validated = await validate(ciOutput, result)
 *
 * console.log(validated.summary)
 * // { total: 5, confirmed: 4, falsePositives: 1, uncertain: 0, missed: 1 }
 *
 * // Filter out false positives
 * const realErrors = validated.validated.filter(d => d.validation !== "false_positive")
 * ```
 */
export const validate = async (
  rawOutput: string,
  parseResult: DiagnosticResult,
  options?: ValidateOptions
): Promise<ValidationResult> => {
  const model = options?.model ?? DEFAULT_MODEL;
  const maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Compact and truncate the CI output
  const compacted = compactCiOutput(rawOutput);
  const truncated = truncateContent(compacted);
  const diagnosticsPrompt = formatDiagnosticsForPrompt(parseResult.diagnostics);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  try {
    const { object } = await generateObject({
      model,
      schema: validationSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(
        truncated,
        parseResult.detectedTool,
        diagnosticsPrompt
      ),
      maxOutputTokens,
      abortSignal: options?.abortSignal ?? abortController.signal,
    });

    return mapToResult(parseResult.diagnostics, object);
  } catch {
    return createFallbackResult(parseResult.diagnostics);
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Creates a validator function with pre-configured options.
 *
 * @example
 * ```ts
 * const validator = createValidator({ model: "anthropic/claude-sonnet-4" })
 * const result = await validator(ciOutput, parseResult)
 * ```
 */
export const createValidator = (defaultOptions?: ValidateOptions) => {
  return (
    rawOutput: string,
    parseResult: DiagnosticResult,
    options?: ValidateOptions
  ) => validate(rawOutput, parseResult, { ...defaultOptions, ...options });
};
