import {
  AllCategories,
  type ErrorCategory,
  type ErrorSource,
  ErrorSources,
  type ExtractedError,
  parse,
  parseActLogs,
  parseGitHubLogs,
  resetDefaultExtractor,
} from "@detent/parser";

export type { ExtractedError } from "@detent/parser";

type ParseFormat = "github-actions" | "act" | "gitlab" | "auto";
type ParseSource = "github" | "gitlab" | "unknown";

interface ParseOptions {
  format?: ParseFormat;
  source?: ParseSource | "auto";
  logs: string;
  runId?: string;
}

interface ParseRunMetadata {
  runId?: string;
  source: ParseSource;
  format: ParseFormat;
  logBytes: number;
  errorCount: number;
}

interface ParseResult {
  errors: ExtractedError[];
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
  errors: ExtractedError[]
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
    const category = error.category ?? "unknown";
    const source = error.source ?? "generic";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  return {
    total: errors.length,
    byCategory,
    bySource,
  };
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

    let errors: ExtractedError[];
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

    const summary = summarizeErrors(errors);
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
      errors,
      summary,
      metadata,
    };
  },
};
