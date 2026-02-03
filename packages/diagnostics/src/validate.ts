import { generateText } from "ai";
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

const JSON_CODE_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)```/;

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
 * Zod schema for parsing the LLM response.
 */
const validationResponseSchema = z.object({
  validated: z.array(
    z.object({
      index: z.number(),
      status: z.enum(["confirmed", "false_positive", "uncertain"]),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string().optional(),
    })
  ),
  missed: z.array(
    z.object({
      message: z.string(),
      filePath: z.string().optional(),
      line: z.number().optional(),
      severity: z.enum(["error", "warning"]).optional(),
      missedReason: z.string(),
    })
  ),
});

const VALIDATION_PROMPT = `You are a CI output analysis expert. Review the raw CI output and the parsed diagnostics to validate the parsing accuracy.

## Raw CI Output
<ci_output>
{{rawOutput}}
</ci_output>

## Detected Tool
{{detectedTool}}

## Parsed Diagnostics
{{parsedDiagnostics}}

## Your Task
1. For each parsed diagnostic, determine if it's:
   - "confirmed": Correctly parsed from the CI output
   - "false_positive": Not actually present in the output or incorrectly interpreted
   - "uncertain": Cannot determine with confidence

2. Identify any errors/warnings in the CI output that were MISSED by the parser.

Respond with ONLY valid JSON matching this structure:
{
  "validated": [
    { "index": 1, "status": "confirmed|false_positive|uncertain", "confidence": "high|medium|low", "reason": "optional explanation" }
  ],
  "missed": [
    { "message": "error message", "filePath": "optional/path", "line": 123, "severity": "error|warning", "missedReason": "why parser missed it" }
  ]
}

Be concise. Only include "reason" for non-confirmed items. Only include "missed" if you find actual errors/warnings not captured.`;

/**
 * Validates parsed diagnostics using an LLM to catch false positives and missed errors.
 *
 * @param rawOutput - The original CI output
 * @param parseResult - The result from the parser
 * @param options - Validation options
 * @returns Validated diagnostics with confidence scores and missed errors
 */
export const validate = async (
  rawOutput: string,
  parseResult: DiagnosticResult,
  options?: ValidateOptions
): Promise<ValidationResult> => {
  const model = options?.model ?? DEFAULT_MODEL;
  const maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  const prompt = VALIDATION_PROMPT.replace(
    "{{rawOutput}}",
    truncateContent(rawOutput)
  )
    .replace("{{detectedTool}}", parseResult.detectedTool ?? "unknown")
    .replace(
      "{{parsedDiagnostics}}",
      formatDiagnosticsForPrompt(parseResult.diagnostics)
    );

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  try {
    const response = await generateText({
      model,
      maxOutputTokens,
      prompt,
      abortSignal: options?.abortSignal ?? abortController.signal,
    });

    const text = response.text.trim();

    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(JSON_CODE_BLOCK_REGEX) ?? [null, text];
    const jsonStr = jsonMatch[1]?.trim() ?? text;

    let parsed: z.infer<typeof validationResponseSchema>;
    try {
      parsed = validationResponseSchema.parse(JSON.parse(jsonStr));
    } catch {
      // If parsing fails, return all as confirmed with low confidence
      return createFallbackResult(parseResult.diagnostics);
    }

    // Map validated results back to diagnostics
    const validated: ValidatedDiagnostic[] = parseResult.diagnostics.map(
      (diag, i) => {
        const validation = parsed.validated.find((v) => v.index === i + 1);
        return {
          ...diag,
          validation: validation?.status ?? "uncertain",
          confidence: validation?.confidence ?? "low",
          reason: validation?.reason,
        };
      }
    );

    const missed: MissedDiagnostic[] = parsed.missed;

    return {
      validated,
      missed,
      summary: {
        total: validated.length,
        confirmed: validated.filter((v) => v.validation === "confirmed").length,
        falsePositives: validated.filter(
          (v) => v.validation === "false_positive"
        ).length,
        uncertain: validated.filter((v) => v.validation === "uncertain").length,
        missed: missed.length,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Creates a fallback result when validation fails.
 */
const createFallbackResult = (diagnostics: Diagnostic[]): ValidationResult => {
  const validated: ValidatedDiagnostic[] = diagnostics.map((d) => ({
    ...d,
    validation: "uncertain" as const,
    confidence: "low" as const,
    reason: "Validation failed to parse LLM response",
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
 * Creates a validator function with pre-configured options.
 */
export const createValidator = (defaultOptions?: ValidateOptions) => {
  return (
    rawOutput: string,
    parseResult: DiagnosticResult,
    options?: ValidateOptions
  ) => validate(rawOutput, parseResult, { ...defaultOptions, ...options });
};
