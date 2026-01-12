// Error parser service - bridges @detent/parser to webhook ParsedError format

import {
  type ExtractedError,
  parseGitHubLogs,
  resetDefaultExtractor,
} from "@detent/parser";

// Interface expected by webhooks.ts (matches the existing definition there)
export interface ParsedError {
  filePath?: string;
  line?: number;
  column?: number;
  message: string;
  category?: string;
  severity?: string;
  ruleId?: string;
  source?: string;
  stackTrace?: string;
  hint?: string;
  workflowJob?: string;
  workflowStep?: string;
  workflowAction?: string;
  /** True if matched by generic fallback parser */
  unknownPattern?: boolean;
  /** True if error may be test output noise (vitest/jest progress, etc.) */
  possiblyTestOutput?: boolean;
}

export interface ParseMetadata {
  logBytes: number;
  jobCount: number;
  parsersAvailable: string[];
}

export interface WorkflowParseResult {
  errors: ParsedError[];
  metadata: ParseMetadata;
}

// Available parsers in the default registry
// HACK: This list mirrors the parsers registered in @detent/parser's createDefaultRegistry.
// If parsers are added/removed there, this list should be updated accordingly.
// Used for user-facing fallback messages to help debug why no errors were found.
const AVAILABLE_PARSERS = [
  "TypeScript",
  "Go",
  "Python",
  "Rust",
  "ESLint",
  "Infrastructure",
  "Generic",
];

// Map ExtractedError from @detent/parser to ParsedError for webhooks
const mapToParsedError = (error: ExtractedError): ParsedError => ({
  filePath: error.file,
  line: error.lineKnown === false ? undefined : error.line,
  column: error.columnKnown === false ? undefined : error.column,
  message: error.message,
  category: error.category,
  severity: error.severity,
  ruleId: error.ruleId,
  source: error.source,
  stackTrace: error.stackTrace,
  hint: error.suggestions?.[0], // Use first suggestion as hint
  workflowJob: error.workflowJob ?? error.workflowContext?.job,
  workflowStep: error.workflowContext?.step,
  workflowAction: error.workflowContext?.action,
  unknownPattern: error.unknownPattern,
  possiblyTestOutput: error.possiblyTestOutput,
});

// Generate a technical fallback error when parsing finds nothing
const createFallbackError = (
  workflowName: string,
  metadata: ParseMetadata
): ParsedError => ({
  message: `Workflow "${workflowName}" failed but no parseable errors found. Analyzed ${formatBytes(metadata.logBytes)} across ${metadata.jobCount} job${metadata.jobCount !== 1 ? "s" : ""}. Parsers tried: ${metadata.parsersAvailable.join(", ")}. Check workflow logs directly.`,
  category: "workflow",
  severity: "error",
  source: "github-actions",
  workflowJob: workflowName,
});

// Format bytes for human-readable display
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Parse workflow logs and extract errors
export const parseWorkflowLogs = (
  logs: string,
  metadata: { totalBytes: number; jobCount: number }
): WorkflowParseResult => {
  // Reset extractor state before parsing (clean slate for each workflow)
  resetDefaultExtractor();

  // Parse logs using GitHub Actions context parser
  const extractedErrors = parseGitHubLogs(logs);

  // Map to ParsedError format
  const errors = extractedErrors.map(mapToParsedError);

  return {
    errors,
    metadata: {
      logBytes: metadata.totalBytes,
      jobCount: metadata.jobCount,
      parsersAvailable: AVAILABLE_PARSERS,
    },
  };
};

// Parse logs and generate fallback if no errors found
export const parseWorkflowLogsWithFallback = (
  logs: string,
  workflowName: string,
  metadata: { totalBytes: number; jobCount: number }
): WorkflowParseResult => {
  const result = parseWorkflowLogs(logs, metadata);

  // If no errors found but workflow failed, add a technical fallback
  if (result.errors.length === 0) {
    result.errors.push(createFallbackError(workflowName, result.metadata));
  }

  return result;
};
