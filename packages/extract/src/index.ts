// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point

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
export type {
  CIError,
  /** @deprecated Use CIError instead */
  ExtractedError,
  /** @deprecated Use CIError instead */
  ExtractedErrorSchemaType,
} from "./schema.js";
export {
  CIErrorSchema,
  CodeSnippetSchema,
  ErrorCategorySchema,
  ErrorSeveritySchema,
  ErrorSourceSchema,
  /** @deprecated Use CIErrorSchema instead */
  ExtractedErrorSchema,
} from "./schema.js";
export {
  createRegisterErrorTool,
  createSetDetectedSourceTool,
} from "./tools.js";
export {
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
  type OnErrorCallback,
  type ToolExtractionOptions,
} from "./types.js";
