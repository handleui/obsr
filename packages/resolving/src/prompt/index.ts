// biome-ignore-all lint/performance/noBarrelFile: This is the prompt submodule's public API

// System prompt and constants

// Types re-exported from @obsr/types
export type {
  CIError,
  ErrorCategory,
  ErrorSeverity,
} from "@obsr/types";

// Formatting functions
export {
  countByCategory,
  countErrors,
  formatError,
  formatErrors,
  formatStackTrace,
  getCategoryPriority,
  prioritizeErrors,
} from "./format.js";
export {
  INTERNAL_FRAME_PATTERNS,
  MAX_ATTEMPTS,
  MAX_STACK_TRACE_LINES,
  SYSTEM_PROMPT,
} from "./system.js";
