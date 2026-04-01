import type { ErrorSource } from "@obsr/types";

/**
 * Minimal interface for errors that can have hints matched.
 * Uses string types for maximum compatibility with different error representations.
 *
 * Note: `source` is intentionally typed as `string` rather than `ErrorSource` to allow
 * errors from external systems or custom parsers that may not use our canonical source
 * names. Non-matching sources simply won't find any hint rules (safe fallback).
 */
export interface HintableError {
  message: string;
  source?: string;
  ruleId?: string;
  category?: string;
}

export interface HintRule {
  source: ErrorSource;
  ruleId?: string;
  messagePattern?: RegExp;
  hint: string;
  docUrl?: string;
  fixPattern?: string;
}

export interface HintMatch<T extends HintableError = HintableError> {
  error: T;
  hints: string[];
}

export type {
  CIError,
  ErrorCategory,
  ErrorSource,
} from "@obsr/types";
