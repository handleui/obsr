import {
  AllCategories,
  type CodeSnippet,
  type ErrorCategory,
  type ErrorSeverity,
  type ErrorSource,
  ErrorSources,
  extractSnippetsForErrors,
  type ExtractedError as ParserExtractedError,
  parse,
  parseActLogs,
  parseGitHubLogs,
  resetDefaultExtractor,
  type WorkflowContext,
} from "@detent/parser";

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

type ParseFormat = "github-actions" | "act" | "gitlab" | "auto";
type ParseSource = "github" | "gitlab" | "unknown";

interface ParseOptions {
  format?: ParseFormat;
  source?: ParseSource | "auto";
  logs: string;
  runId?: string;
  workspacePath?: string;
}

interface ParseRunMetadata {
  runId?: string;
  source: ParseSource;
  format: ParseFormat;
  logBytes: number;
  errorCount: number;
}

interface ParseResult {
  errors: ApiExtractedError[];
  summary: {
    total: number;
    byCategory: Record<ErrorCategory, number>;
    bySource: Record<ErrorSource, number>;
  };
  metadata: ParseRunMetadata;
}

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

const looksLikeActLogs = (logs: string): boolean => {
  return ACT_LOGS_PATTERN.test(logs);
};

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
  format: ParseFormat | undefined,
  source: ParseSource | "auto" | undefined
): { format: ParseFormat; source: ParseSource } => {
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
  filePath: error.file,
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

const recordParseRun = async (_metadata: ParseRunMetadata): Promise<void> => {
  await Promise.resolve();
};

export const parseService = {
  // Parse CI logs and extract errors
  parse: async (options: ParseOptions): Promise<ParseResult> => {
    resetDefaultExtractor();
    const resolved = resolveFormat(
      options.logs,
      options.format,
      options.source
    );

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

    const errorsWithSnippets = await addSnippets(errors, options.workspacePath);
    const summary = summarizeErrors(errorsWithSnippets);
    const logBytes = new TextEncoder().encode(options.logs).length;
    const metadata: ParseRunMetadata = {
      runId: options.runId,
      source: resolved.source,
      format: resolved.format,
      logBytes,
      errorCount: summary.total,
    };

    await recordParseRun(metadata);

    return {
      errors: errorsWithSnippets.map(mapError),
      summary,
      metadata,
    };
  },
};
