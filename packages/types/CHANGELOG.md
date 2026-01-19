# @detent/types

## 0.5.0

### Minor Changes

- e1cb50b: Add PII and sensitive data redaction utilities.
  Exports redactPII, redactSensitiveData, and sanitizeForTelemetry functions with patterns for API keys, tokens, and credentials.

## 0.4.0

### Minor Changes

- 74eab1c: Add error fingerprinting types for cross-repo error tracking.
  New `ErrorFingerprints`, `ErrorSignature`, and `ErrorOccurrence` types support hierarchical error identification.

## 0.3.0

### Minor Changes

- 6bfca1a: Add shared types package with foundational error types.
  Exports ErrorCategory, ErrorSeverity, ErrorSource, CodeSnippet, and WorkflowContext.

## 0.2.0

### Minor Changes

- 5fa4de0: Add shared types package with foundational error types.
  Exports ErrorCategory, ErrorSeverity, ErrorSource, CodeSnippet, and WorkflowContext.
