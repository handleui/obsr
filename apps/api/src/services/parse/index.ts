import {
  AllCategories,
  type ErrorCategory,
  type ErrorSource,
  ErrorSources,
  extractSnippetsForErrors,
  type ExtractedError as ParserExtractedError,
  parse,
  parseActLogs,
  parseGitHubLogs,
  resetDefaultExtractor,
} from "@detent/parser";
import type { Env } from "../../types/env";
import { enrichErrorsWithFileContext } from "../error-enrichment";
import { persistParseRun } from "./persistence";
import {
  type ApiExtractedError,
  type GitHubContext,
  type LogFormat,
  type ParseRequest,
  type ParseResponse,
  type ParseResult,
  type ParseSource,
  ParseTimeoutError,
} from "./types";
import { validateParseRequest } from "./validation";

// Types and errors exported via types.ts (import directly from "./parse/types" to avoid barrel)

// Timeout for parsing (30 seconds)
const PARSE_TIMEOUT_MS = 30_000;

// Re-export types for external use
export type { FileEnrichmentContext, GitHubContext } from "./types";

// Source detection signals
const sourceSignals = {
  github: [
    "##[group]",
    "##[error]",
    "##[warning]",
    "GITHUB_ACTIONS=",
    "::error",
    "::warning",
  ],
  gitlab: [
    "Running with gitlab-runner",
    "section_start:",
    "section_end:",
    "CI_JOB_ID=",
    "CI_PIPELINE_ID=",
  ],
} as const;

const ACT_LOGS_PATTERN = /^\[[^\n\]]+\/[^\n\]]+\]/m;

const looksLikeActLogs = (logs: string): boolean => ACT_LOGS_PATTERN.test(logs);

const inferSourceFromLogs = (logs: string): ParseSource => {
  const lowered = logs.toLowerCase();
  if (
    sourceSignals.github.some((signal) =>
      lowered.includes(signal.toLowerCase())
    )
  ) {
    return "github";
  }
  if (
    sourceSignals.gitlab.some((signal) =>
      lowered.includes(signal.toLowerCase())
    )
  ) {
    return "gitlab";
  }
  return "unknown";
};

const resolveFormat = (
  logs: string,
  format: LogFormat | undefined,
  source: ParseSource | "auto" | undefined
): { format: LogFormat; source: ParseSource } => {
  const inferredSource = inferSourceFromLogs(logs);
  const resolvedSource = source && source !== "auto" ? source : inferredSource;

  if (format && format !== "auto") {
    return { format, source: resolvedSource };
  }

  if (looksLikeActLogs(logs)) {
    return { format: "act", source: resolvedSource };
  }

  if (resolvedSource === "github") {
    return { format: "github-actions", source: resolvedSource };
  }

  if (resolvedSource === "gitlab") {
    return { format: "gitlab", source: resolvedSource };
  }

  return { format: "auto", source: resolvedSource };
};

const summarizeErrors = (
  errors: ParserExtractedError[]
): {
  total: number;
  byCategory: Record<ErrorCategory, number>;
  bySource: Record<ErrorSource, number>;
} => {
  const byCategory = Object.fromEntries(
    AllCategories.map((category) => [category, 0])
  ) as Record<ErrorCategory, number>;
  const allSources = Object.values(ErrorSources);
  const bySource = Object.fromEntries(
    allSources.map((source) => [source, 0])
  ) as Record<ErrorSource, number>;

  for (const error of errors) {
    const category: ErrorCategory = error.category ?? "unknown";
    const source: ErrorSource = error.source ?? "generic";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  return {
    total: errors.length,
    byCategory,
    bySource,
  };
};

const mapError = (error: ParserExtractedError): ApiExtractedError => ({
  message: error.message,
  filePath: error.filePath,
  line: error.line,
  column: error.column,
  severity: error.severity,
  stackTrace: error.stackTrace,
  ruleId: error.ruleId,
  category: error.category,
  workflowContext: error.workflowContext,
  workflowJob: error.workflowJob,
  source: error.source,
  unknownPattern: error.unknownPattern,
  codeSnippet: error.codeSnippet,
  suggestions: error.suggestions,
  lineKnown: error.lineKnown,
  columnKnown: error.columnKnown,
  stackTraceTruncated: error.stackTraceTruncated,
  messageTruncated: error.messageTruncated,
  hint: error.hint,
  exitCode: error.exitCode,
  isInfrastructure: error.isInfrastructure,
});

const addSnippets = async (
  errors: ParserExtractedError[],
  workspacePath: string | undefined
): Promise<ParserExtractedError[]> => {
  if (!workspacePath) {
    return errors;
  }
  const { errors: withSnippets } = await extractSnippetsForErrors(
    errors,
    workspacePath
  );
  return withSnippets;
};

interface ParseInternalOptions {
  logs: string;
  format: LogFormat;
  source: ParseSource | "auto";
  runId?: string;
  workspacePath?: string;
  /** GitHub context for remote file enrichment */
  githubContext?: GitHubContext;
}

const parseLogsInternal = async (
  options: ParseInternalOptions
): Promise<ParseResult> => {
  resetDefaultExtractor();
  const resolved = resolveFormat(options.logs, options.format, options.source);

  let errors: ParserExtractedError[];
  switch (resolved.format) {
    case "act":
      errors = parseActLogs(options.logs);
      break;
    case "github-actions":
      errors = parseGitHubLogs(options.logs);
      break;
    case "gitlab":
      errors = parse(options.logs);
      break;
    default:
      errors = parse(options.logs);
      break;
  }

  // Step 1: Add snippets from local workspace (if available)
  let errorsWithSnippets = await addSnippets(errors, options.workspacePath);

  // Step 2: Enrich remaining errors via GitHub API (if context provided)
  // Note: enrichErrorsWithFileContext handles its own logging
  if (options.githubContext) {
    const { errors: enrichedErrors } = await enrichErrorsWithFileContext(
      errorsWithSnippets,
      options.githubContext
    );
    errorsWithSnippets = enrichedErrors;
  }

  const summary = summarizeErrors(errorsWithSnippets);
  const logBytes = new TextEncoder().encode(options.logs).length;

  return {
    errors: errorsWithSnippets.map(mapError),
    summary,
    metadata: {
      runId: options.runId,
      source: resolved.source,
      format: resolved.format,
      logBytes,
      errorCount: summary.total,
    },
  };
};

const parseWithTimeout = (
  options: ParseInternalOptions
): Promise<ParseResult> => {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ParseTimeoutError());
    }, PARSE_TIMEOUT_MS);
  });

  return Promise.race([parseLogsInternal(options), timeoutPromise]).finally(
    () => {
      clearTimeout(timeoutId);
    }
  );
};

export const parseService = {
  /**
   * Parse CI logs and extract errors (without persistence).
   * Useful for testing and cases where persistence is not needed.
   */
  parse: (options: {
    logs: string;
    format?: LogFormat;
    source?: ParseSource | "auto";
    runId?: string;
    workspacePath?: string;
    /** GitHub context for enriching errors with file snippets from remote repo */
    githubContext?: GitHubContext;
  }): Promise<ParseResult> =>
    parseWithTimeout({
      logs: options.logs,
      format: options.format ?? "auto",
      source: options.source ?? "auto",
      runId: options.runId,
      workspacePath: options.workspacePath,
      githubContext: options.githubContext,
    }),

  /**
   * Parse CI logs, extract errors, and persist to database.
   * This is the main entry point for the parse flow.
   */
  parseAndPersist: async (
    request: ParseRequest,
    env: Env
  ): Promise<ParseResponse> => {
    // 1. Validate input (throws ValidationError on failure)
    const validated = validateParseRequest(request);

    // 2. Parse logs with timeout (throws ParseTimeoutError on timeout)
    const result = await parseWithTimeout({
      logs: validated.logs,
      format: validated.format,
      source: validated.source,
      runId: validated.runId,
      workspacePath: validated.workspacePath,
      githubContext: request.githubContext,
    });

    // 3. Persist to database (returns persisted: false on failure)
    const { persisted } = await persistParseRun(env, result, validated);

    return { ...result, persisted };
  },
};
