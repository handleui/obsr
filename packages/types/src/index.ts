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
  ResolveCreateStatus,
  ResolveStatus,
  ResolveSummary,
  ResolveType,
  ResolveUpdateStatus,
} from "./resolve.js";
export { ResolveStatuses, ResolveTypes } from "./resolve.js";
export type {
  ResolverDiagnostic,
  ResolverDiagnosticsContext,
} from "./resolver-diagnostics.js";
export type {
  ResolverQueuePayload,
  ResolverQueueSource,
} from "./resolver-queue.js";
export {
  getResolverQueueResolveIds,
  parseResolverQueuePayload,
  ResolverQueueSources,
} from "./resolver-queue.js";
export type { DiagnosticLike, RedactionPattern } from "./sanitize.js";
export {
  redactionPatterns,
  redactPII,
  redactSensitiveData,
  sanitizeForTelemetry,
  scrubDiagnostic,
  scrubFilePath,
  scrubSecrets,
} from "./sanitize.js";
export type { ErrorSeverity } from "./severity.js";
export type { ErrorSource } from "./source.js";
export { ErrorSources } from "./source.js";
