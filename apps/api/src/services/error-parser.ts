// Error parser service - bridges @detent/parser to webhook ParsedError format

import {
  getDefaultRegistry,
  getUnsupportedToolDisplayName,
  isUnsupportedToolID,
  parseGitHubLogs,
  reportUnknownPatterns,
  resetDefaultExtractor,
  setUnknownPatternReporter,
} from "@detent/parser";
import type { ExtractedError } from "@detent/types";
import { createUnknownPatternReporter } from "../lib/sentry";

// Re-export and import separately to satisfy both type checker and linter
export type { ParserContext } from "../lib/sentry";

// Import for local use
import type { ParserContext } from "../lib/sentry";

// Interface expected by webhooks.ts - mirrors ExtractedError from @detent/parser
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
  /** Full suggestions array from parser */
  suggestions?: string[];
  /** Code snippet with surrounding context */
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  };
  /** Confidence flags */
  lineKnown?: boolean;
  columnKnown?: boolean;
  messageTruncated?: boolean;
  stackTraceTruncated?: boolean;
  /** Infrastructure error context */
  exitCode?: number;
  isInfrastructure?: boolean;
}

export interface ParseMetadata {
  logBytes: number;
  jobCount: number;
  parsersAvailable: string[];
}

export interface WorkflowParseResult {
  errors: ParsedError[];
  metadata: ParseMetadata;
  /** Unique unsupported tool display names detected from step commands */
  detectedUnsupportedTools: string[];
  /** Parser context for Sentry error reporting (pass to captureWebhookError) */
  parserContext: ParserContext;
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

// Initialize unknown pattern reporter for Sentry telemetry
// Called lazily to ensure Sentry is initialized before setting reporter
let reporterInitialized = false;
const ensureReporterInitialized = (): void => {
  if (!reporterInitialized) {
    setUnknownPatternReporter(createUnknownPatternReporter());
    reporterInitialized = true;
  }
};

// Map ExtractedError from @detent/parser to ParsedError for webhooks
const mapToParsedError = (error: ExtractedError): ParsedError => ({
  filePath: error.filePath,
  line: error.lineKnown === false ? undefined : error.line,
  column: error.columnKnown === false ? undefined : error.column,
  message: error.message,
  category: error.category,
  severity: error.severity,
  ruleId: error.ruleId,
  source: error.source,
  stackTrace: error.stackTrace,
  hint: error.suggestions?.[0],
  suggestions: error.suggestions ? [...error.suggestions] : undefined,
  codeSnippet: error.codeSnippet
    ? {
        lines: [...error.codeSnippet.lines],
        startLine: error.codeSnippet.startLine,
        errorLine: error.codeSnippet.errorLine,
        language: error.codeSnippet.language,
      }
    : undefined,
  workflowJob: error.workflowJob ?? error.workflowContext?.job,
  workflowStep: error.workflowContext?.step,
  workflowAction: error.workflowContext?.action,
  unknownPattern: error.unknownPattern,
  possiblyTestOutput: error.possiblyTestOutput,
  lineKnown: error.lineKnown,
  columnKnown: error.columnKnown,
  messageTruncated: error.messageTruncated,
  stackTraceTruncated: error.stackTraceTruncated,
  exitCode: error.exitCode,
  isInfrastructure: error.isInfrastructure,
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

// Detect unsupported tools from workflow step commands.
// Note: Detection requires `workflowStep` to be populated on parsed errors.
// Tools that fail without producing parseable errors won't be detected.
const detectUnsupportedToolsFromSteps = (errors: ParsedError[]): string[] => {
  // Collect unique step commands
  const stepCommands = new Set<string>();
  for (const error of errors) {
    if (error.workflowStep) {
      stepCommands.add(error.workflowStep);
    }
  }

  if (stepCommands.size === 0) {
    return [];
  }

  // Run detection on all step commands using cached registry
  // getDefaultRegistry() returns a singleton, avoiding repeated instantiation
  const registry = getDefaultRegistry();
  const unsupportedSet = new Set<string>();

  for (const step of stepCommands) {
    const result = registry.detectTools(step, { checkSupport: true });
    for (const tool of result.tools) {
      if (isUnsupportedToolID(tool.id)) {
        const displayName = getUnsupportedToolDisplayName(tool.id);
        if (displayName) {
          unsupportedSet.add(displayName);
        }
      }
    }
  }

  return [...unsupportedSet].sort();
};

// Parse workflow logs and extract errors
export const parseWorkflowLogs = (
  logs: string,
  metadata: { totalBytes: number; jobCount: number }
): WorkflowParseResult => {
  // Ensure unknown pattern reporter is wired up for Sentry telemetry
  ensureReporterInitialized();

  // Reset extractor state before parsing (clean slate for each workflow)
  resetDefaultExtractor();

  // Parse logs using GitHub Actions context parser
  const extractedErrors = parseGitHubLogs(logs);

  // Report unknown patterns to Sentry (if any errors have unknownPattern: true)
  reportUnknownPatterns(extractedErrors);

  // Map to ParsedError format
  const errors = extractedErrors.map(mapToParsedError);

  // Detect unsupported tools from step commands
  const detectedUnsupportedTools = detectUnsupportedToolsFromSteps(errors);

  // Create parser context for Sentry (returned to caller for use with captureWebhookError)
  const parserContext: ParserContext = {
    logBytes: metadata.totalBytes,
    jobCount: metadata.jobCount,
    errorCount: errors.length,
    parsersAvailable: AVAILABLE_PARSERS,
    detectedUnsupportedTools,
  };

  return {
    errors,
    metadata: {
      logBytes: metadata.totalBytes,
      jobCount: metadata.jobCount,
      parsersAvailable: AVAILABLE_PARSERS,
    },
    detectedUnsupportedTools,
    parserContext,
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
