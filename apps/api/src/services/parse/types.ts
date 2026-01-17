import type { ErrorCategory, ErrorSource, ExtractedError } from "@detent/types";

// Re-export ExtractedError for use by other modules in the API
export type { ExtractedError } from "@detent/types";

// API error type alias (maintains backwards compatibility with API consumers)
export type ApiExtractedError = ExtractedError;

// Request types
export interface ParseRequest {
  logs?: string;
  logZipBase64?: string;
  format?: string;
  source?: string;
  runId?: string;
  commitSha?: string;
  repository?: string;
  provider?: string;
  projectId?: string;
  workspacePath?: string;
}

// Valid enum values
export const VALID_FORMATS = [
  "github-actions",
  "act",
  "gitlab",
  "auto",
] as const;
export type LogFormat = (typeof VALID_FORMATS)[number];

export const VALID_SOURCES = ["github", "gitlab", "auto"] as const;
export type LogSource = (typeof VALID_SOURCES)[number];

export const VALID_PROVIDERS = ["github", "gitlab"] as const;
export type Provider = (typeof VALID_PROVIDERS)[number];

export type ParseSource = "github" | "gitlab" | "unknown";

// Validated request after validation passes
export interface ValidatedParseRequest {
  logs: string;
  format: LogFormat;
  source: LogSource;
  provider: Provider | null;
  runId?: string;
  commitSha?: string;
  repository?: string;
  projectId?: string;
  workspacePath?: string;
}

// Metadata about the parse run
export interface ParseRunMetadata {
  runId?: string;
  source: ParseSource;
  format: LogFormat;
  logBytes: number;
  errorCount: number;
}

// Internal parse result (before persistence)
export interface ParseResult {
  errors: ExtractedError[];
  summary: {
    total: number;
    byCategory: Record<ErrorCategory, number>;
    bySource: Record<ErrorSource, number>;
  };
  metadata: ParseRunMetadata;
}

// Final response with persistence status
export interface ParseResponse extends ParseResult {
  persisted: boolean;
}

// Custom error types
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ValidationError";
  }
}

export class ParseTimeoutError extends Error {
  constructor(message = "Parse timeout exceeded") {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ParseTimeoutError";
  }
}

export class DecompressionError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DecompressionError";
  }
}
