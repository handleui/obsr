export type { ErrorCategory } from "./category.js";
export { AllCategories, isValidCategory } from "./category.js";
export type { CodeSnippet, WorkflowContext } from "./context.js";
export { cloneWorkflowContext } from "./context.js";
export type {
  CIProvider,
  CIProviderID,
  CIProviderOptions,
  ContextParser,
  LineContext,
  ParseLineResult,
} from "./context-parser.js";
export type {
  CICodeSnippet,
  CIError,
  CIWorkflowContext,
} from "./diagnostic.js";

/** @deprecated Use CIError instead */
export type { DiagnosticError } from "./diagnostic.js";
/** @deprecated Use CIError instead */
export type { ExtractedError } from "./diagnostic.js";
/** @deprecated Use CIError instead */
export type { MutableExtractedError } from "./diagnostic.js";

export {
  CIErrorSchema,
  CIErrorSchemaWithValidation,
  CodeSnippetSchema,
  ErrorCategorySchema,
  ErrorSeveritySchema,
  ErrorSourceSchema,
  WorkflowContextSchema,
} from "./diagnostic.js";
export type {
  JobEvent,
  JobStatus,
  ManifestEvent,
  ManifestInfo,
  ManifestJob,
  StepEvent,
  StepStatus,
} from "./events.js";
export { JobStatuses, StepStatuses } from "./events.js";
export type {
  ErrorFingerprints,
  ErrorOccurrence,
  ErrorSignature,
} from "./fingerprint.js";
export type {
  HealCreateStatus,
  HealStatus,
  HealSummary,
  HealType,
  HealUpdateStatus,
} from "./heal.js";
export { HealStatuses, HealTypes } from "./heal.js";
export type { RedactionPattern } from "./sanitize.js";
export {
  redactionPatterns,
  redactPII,
  redactSensitiveData,
  sanitizeForTelemetry,
} from "./sanitize.js";
export type { ErrorSeverity } from "./severity.js";
export type { ErrorSource } from "./source.js";
export { ErrorSources } from "./source.js";
