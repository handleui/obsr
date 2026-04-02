export const MAX_INGEST_REQUEST_BYTES = 512_000;
export const MAX_RAW_TEXT_CHARS = 120_000;
export const MAX_PERSISTED_RAW_TEXT_CHARS = 50_000;
export const MAX_EVIDENCE_CHARS = 500;
export const MAX_SYNTHESIS_DIAGNOSTICS = 8;
export const MAX_BRIEF_DIAGNOSTICS = 5;

const categoryPriority = [
  "security",
  "infrastructure",
  "config",
  "dependency",
  "compile",
  "type-check",
  "test",
  "runtime",
  "lint",
  "unknown",
] as const;

export const issueCategoryRank = new Map(
  categoryPriority.map((category, index) => [category, index])
);
