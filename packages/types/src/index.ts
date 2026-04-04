export type { IssueFingerprints } from "./fingerprint.js";
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
