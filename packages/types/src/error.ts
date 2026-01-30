/**
 * ExtractedError represents a single error extracted from CI output.
 * This is the canonical definition shared across all packages.
 */

import type { ErrorCategory } from "./category.js";
import type { CodeSnippet, WorkflowContext } from "./context.js";
import type { ErrorSeverity } from "./severity.js";
import type { ErrorSource } from "./source.js";

/**
 * ExtractedError represents a single error extracted from CI output.
 */
export interface ExtractedError {
  readonly message: string;
  /**
   * File path where error occurred.
   * SECURITY: May contain user paths (e.g., /Users/john/...). Use redactPII() before external transmission.
   */
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity?: ErrorSeverity;
  /**
   * Raw error output from tool.
   * SECURITY: May contain credentials or PII. Use redactPII() before external transmission.
   */
  readonly raw?: string;
  /**
   * Multi-line stack trace for detailed error context.
   * SECURITY: May contain user paths and sensitive context. Use redactPII() before external transmission.
   */
  readonly stackTrace?: string;
  /** e.g., "no-var", "TS2749" */
  readonly ruleId?: string;
  /** lint, type-check, test, etc. */
  readonly category?: ErrorCategory;
  /** Job/step info */
  readonly workflowContext?: WorkflowContext;
  /** Flattened from WorkflowContext.job for easier access */
  readonly workflowJob?: string;
  /** "eslint", "typescript", "go", etc. */
  readonly source?: ErrorSource;
  /** True if matched by generic fallback parser */
  readonly unknownPattern?: boolean;

  // AI-optimized fields for enhanced context
  /** Source code context around error */
  readonly codeSnippet?: CodeSnippet;
  /** Hints for fixing the error (merged from suggestions + hint) */
  readonly hints?: readonly string[];
  /** True if line is a real value, false if line=0 means unknown */
  readonly lineKnown?: boolean;
  /** True if error can be auto-fixed by the tool (e.g., biome check --write) */
  readonly fixable?: boolean;
  /** True if error may be test output noise (vitest/jest progress, etc.) */
  readonly possiblyTestOutput?: boolean;
}

/**
 * Create a mutable error builder for constructing ExtractedError objects.
 * This helps with building errors incrementally (e.g., multi-line parsing).
 */
export interface MutableExtractedError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: ErrorSeverity;
  raw?: string;
  stackTrace?: string;
  ruleId?: string;
  category?: ErrorCategory;
  workflowContext?: WorkflowContext;
  workflowJob?: string;
  source?: ErrorSource;
  unknownPattern?: boolean;
  codeSnippet?: CodeSnippet;
  hints?: string[];
  lineKnown?: boolean;
  fixable?: boolean;
  possiblyTestOutput?: boolean;
}
