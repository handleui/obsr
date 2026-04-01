import type { CIError } from "@obsr/types";

export type { CIError } from "@obsr/types";

export type ValidationReason =
  | "file_missing"
  | "line_out_of_bounds"
  | "code_changed";

export interface StaleError {
  error: CIError;
  reason: ValidationReason;
}

export interface PreflightResult {
  valid: CIError[];
  stale: StaleError[];
}
