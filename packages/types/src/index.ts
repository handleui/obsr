export type { ErrorCategory } from "./category.js";
export { AllCategories, isValidCategory } from "./category.js";
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
