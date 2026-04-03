export {
  createHintMatcher,
  enrichErrorsWithHints,
  getHintsForError,
  HINT_RULES,
  matchHints,
} from "./hints/index.js";
export * from "./signatures/index.js";
export type {
  ErrorCategory,
  ErrorSource,
  FingerprintableDiagnostic,
  HintableError,
  HintMatch,
  HintRule,
} from "./types.js";
