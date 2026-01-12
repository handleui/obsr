import type {
  CodeSnippet,
  ErrorCategory,
  ErrorSeverity,
  ErrorSource,
  WorkflowContext,
} from "@detent/parser";

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

// API error type (what we return to clients)
export interface ApiExtractedError {
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity?: ErrorSeverity;
  readonly stackTrace?: string;
  readonly ruleId?: string;
  readonly category?: ErrorCategory;
  readonly workflowContext?: WorkflowContext;
  readonly workflowJob?: string;
  readonly source?: ErrorSource;
  readonly unknownPattern?: boolean;
  readonly codeSnippet?: CodeSnippet;
  readonly suggestions?: readonly string[];
  readonly lineKnown?: boolean;
  readonly columnKnown?: boolean;
  readonly stackTraceTruncated?: boolean;
  readonly messageTruncated?: boolean;
  readonly hint?: string;
  readonly exitCode?: number;
  readonly isInfrastructure?: boolean;
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
  errors: ApiExtractedError[];
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
