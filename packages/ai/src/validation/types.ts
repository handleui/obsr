import type { Diagnostic } from "@detent/diagnostics";

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
 * Token usage from the AI validation call.
 */
export interface ValidationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  /** Token usage from the AI call */
  usage?: ValidationUsage;
  /** Cost in USD for the validation call */
  costUsd?: number;
  /** Whether validation failed to complete */
  failed?: boolean;
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
