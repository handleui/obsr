// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point

export type { CIError } from "@detent/types";
export {
  CIErrorSchema,
  CodeSnippetSchema,
  ErrorCategorySchema,
  ErrorSeveritySchema,
  ErrorSourceSchema,
} from "@detent/types";
export { type ExtractionOptions, extractErrors } from "./extract.js";
export {
  type CompactResult,
  compactCiOutput,
  type LogSegment,
  type PrepareResult,
  prepareForPrompt,
  sanitizeForPrompt,
  type TruncateResult,
  truncateContent,
} from "./preprocess.js";
export {
  buildUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_TOOLS,
} from "./prompt.js";
export { extractRelatedFiles } from "./related-files.js";
export {
  createRegisterErrorTool,
  createSetDetectedSourceTool,
} from "./tools.js";
export {
  type ExtractionMetrics,
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
  type OnErrorCallback,
  type ToolExtractionOptions,
} from "./types.js";
