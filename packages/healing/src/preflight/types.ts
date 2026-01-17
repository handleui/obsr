import type { ExtractedError } from "@detent/parser";

export type ValidationReason =
  | "file_missing"
  | "line_out_of_bounds"
  | "code_changed";

export interface StaleError {
  error: ExtractedError;
  reason: ValidationReason;
}

export interface PreflightResult {
  valid: ExtractedError[];
  stale: StaleError[];
}
