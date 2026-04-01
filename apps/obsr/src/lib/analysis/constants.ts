export const MAX_ANALYSIS_INPUT_CHARS = 120_000;
export const MAX_PERSISTED_RAW_LOG_CHARS = 50_000;
export const MAX_EVIDENCE_CHARS = 500;
export const MAX_ANALYSIS_REQUEST_BYTES = 512_000;
export const MAX_PROMPT_DIAGNOSTICS = 5;
export const MAX_PROMPT_CHARS = 2000;

const categoryPriority = [
  "config",
  "dependency",
  "compile",
  "type-check",
  "test",
  "runtime",
  "security",
  "infrastructure",
  "lint",
  "docs",
  "metadata",
  "unknown",
] as const;

export const categoryRank = new Map(
  categoryPriority.map((category, index) => [category, index])
);
