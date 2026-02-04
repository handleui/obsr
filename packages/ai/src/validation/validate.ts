import type { Diagnostic, DiagnosticResult } from "@detent/diagnostics";
import { generateObject } from "ai";
import { z } from "zod";
import { normalizeModelId } from "../client.js";
import { estimateCost } from "../pricing.js";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
} from "../types.js";
import { prepareForPrompt } from "./compact.js";
import type {
  ValidatedDiagnostic,
  ValidateOptions,
  ValidationResult,
  ValidationUsage,
} from "./types.js";

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
 * Maps generateObject output to base ValidationResult (without usage/cost).
 * Uses a Map for O(1) lookups instead of O(n) .find() calls.
 */
const mapToResult = (
  diagnostics: Diagnostic[],
  object: z.infer<typeof validationSchema>
): Omit<ValidationResult, "usage" | "costUsd"> => {
  // Build index map for O(1) lookups (avoids O(n^2) with .find())
  const validationMap = new Map(object.validated.map((v) => [v.index, v]));

  const validated: ValidatedDiagnostic[] = diagnostics.map((diag, i) => {
    const validation = validationMap.get(i + 1);
    return {
      ...diag,
      validation: validation?.status ?? "uncertain",
      confidence: validation?.confidence ?? "low",
      reason: validation?.reason,
    };
  });

  // Single-pass summary calculation (avoids 3 separate .filter() iterations)
  let confirmed = 0;
  let falsePositives = 0;
  let uncertain = 0;
  for (const v of validated) {
    if (v.validation === "confirmed") {
      confirmed++;
    } else if (v.validation === "false_positive") {
      falsePositives++;
    } else {
      uncertain++;
    }
  }
  const summary = {
    total: validated.length,
    confirmed,
    falsePositives,
    uncertain,
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
 * @returns Validated diagnostics with confidence scores, missed errors, usage, and cost
 *
 * @example
 * ```ts
 * import { extract } from "@detent/diagnostics"
 * import { validate } from "@detent/ai/validation"
 *
 * const result = extract(ciOutput)
 * const validated = await validate(ciOutput, result)
 *
 * // Filter out false positives
 * const realErrors = validated.validated.filter(d => d.validation !== "false_positive")
 * console.log(`Validation cost: $${validated.costUsd}`)
 * ```
 */
export const validate = async (
  rawOutput: string,
  parseResult: DiagnosticResult,
  options?: ValidateOptions
): Promise<ValidationResult> => {
  const modelName = options?.model ?? DEFAULT_FAST_MODEL;
  const model = normalizeModelId(modelName);
  const maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Compact, sanitize, and truncate the CI output (includes prompt injection protection)
  const preparedOutput = prepareForPrompt(rawOutput);
  const diagnosticsPrompt = formatDiagnosticsForPrompt(parseResult.diagnostics);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  try {
    const { object, usage } = await generateObject({
      model,
      schema: validationSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(
        preparedOutput,
        parseResult.detectedTool,
        diagnosticsPrompt
      ),
      maxOutputTokens,
      abortSignal: options?.abortSignal ?? abortController.signal,
    });

    const result = mapToResult(parseResult.diagnostics, object);

    // Add usage and cost information (AI SDK may return undefined for some models)
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const validationUsage: ValidationUsage = {
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    };
    const costUsd = estimateCost(modelName, inputTokens, outputTokens);

    return {
      ...result,
      usage: validationUsage,
      costUsd,
    };
  } catch {
    return createFallbackResult(parseResult.diagnostics);
  } finally {
    clearTimeout(timeoutId);
  }
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
