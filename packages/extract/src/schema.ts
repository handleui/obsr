// biome-ignore-all lint/performance/noBarrelFile: Re-exports for backward compat
/**
 * Re-export CI error schemas from @detent/types.
 * @deprecated Import directly from @detent/types instead.
 */

export type {
  CIError,
  CIError as ExtractedErrorSchemaType,
  /** @deprecated Use CIError instead */
  ExtractedError,
} from "@detent/types";
export {
  CIErrorSchema,
  CIErrorSchema as ExtractedErrorSchema,
  CodeSnippetSchema,
  ErrorCategorySchema,
  ErrorSeveritySchema,
  ErrorSourceSchema,
} from "@detent/types";
