// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point

export { type ExtractionOptions, extractErrors } from "./extract.js";
export {
  compactCiOutput,
  type PrepareResult,
  prepareForPrompt,
  sanitizeForPrompt,
  type TruncateResult,
  truncateContent,
} from "./preprocess.js";
export { buildUserPrompt, EXTRACTION_SYSTEM_PROMPT } from "./prompt.js";
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
  type ExtractionResult,
  ExtractionResultSchema,
  type ExtractionUsage,
} from "./types.js";
