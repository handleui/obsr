// Comment formatter for GitHub PR comments
// Formats error summaries in a clean, scannable format

import type { ParsedError } from "./error-parser";

export interface WorkflowRunResult {
  name: string;
  id: number;
  conclusion: string;
  errorCount: number;
}

export interface FormatCommentOptions {
  owner: string;
  repo: string;
  headSha: string;
  runs: WorkflowRunResult[];
  errors: ParsedError[];
  totalErrors: number;
}

// Top-level regex for performance (avoid creating in loops)
const WHITESPACE_PATTERN = /\s+/g;
const PIPE_PATTERN = /\|/g;
const BACKTICK_PATTERN = /`/g;

// Helper: escape text for markdown table cells
// Pipe chars break table structure, backticks can interfere with inline code
const escapeTableCell = (text: string): string => {
  return text.replace(PIPE_PATTERN, "\\|").replace(BACKTICK_PATTERN, "\\`");
};

// Helper: URL encode file path for GitHub blob links
// Encodes each path segment separately to preserve slashes
const encodeFilePath = (filePath: string): string => {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
};

// Helper: truncate file path for display
const truncatePath = (path: string, maxLen = 40): string => {
  if (path.length <= maxLen) {
    return path;
  }
  const parts = path.split("/");
  if (parts.length <= 2) {
    // For flat paths, truncate from start with ellipsis prefix
    return `...${path.slice(-(maxLen - 3))}`;
  }
  return `.../${parts.slice(-2).join("/")}`;
};

// Helper: truncate and sanitize message for table display
const truncateMessage = (message: string, maxLen = 60): string => {
  // Remove newlines and extra whitespace
  const clean = message.replace(WHITESPACE_PATTERN, " ").trim();
  // Escape pipe chars to prevent table breakage
  const escaped = escapeTableCell(clean);
  if (escaped.length <= maxLen) {
    return escaped;
  }
  return `${escaped.slice(0, maxLen - 3)}...`;
};

// Helper: build GitHub blob URL with proper encoding
const buildFileLink = (
  filePath: string,
  line: number | undefined,
  owner: string,
  repo: string,
  headSha: string
): string => {
  const displayPath = truncatePath(filePath);
  const encodedPath = encodeFilePath(filePath);
  const lineAnchor = line ? `#L${line}` : "";
  return `[\`${displayPath}\`](https://github.com/${owner}/${repo}/blob/${headSha}/${encodedPath}${lineAnchor})`;
};

// Helper: format a single workflow run row
const formatWorkflowRow = (
  run: WorkflowRunResult,
  owner: string,
  repo: string
): string => {
  const status = run.conclusion === "success" ? "Passed" : "Failed";
  const statusIcon = run.conclusion === "success" ? "✅" : "❌";
  const safeName = escapeTableCell(run.name);
  return `| [${safeName}](https://github.com/${owner}/${repo}/actions/runs/${run.id}) | ${statusIcon} ${status} | ${run.errorCount} |`;
};

// Helper: format a single error row (with Source column)
const formatErrorRow = (
  error: ParsedError,
  owner: string,
  repo: string,
  headSha: string
): string => {
  const file = error.filePath
    ? buildFileLink(error.filePath, error.line, owner, repo, headSha)
    : "_unknown_";
  const line = error.line ?? "-";
  const message = truncateMessage(error.message, 60);
  const rawSource = error.source ?? error.category ?? "-";
  const source = escapeTableCell(rawSource);
  return `| ${file} | ${line} | ${message} | ${source} |`;
};

// Helper: format error row for uncertain errors (without Source column)
const formatUncertainErrorRow = (
  error: ParsedError,
  owner: string,
  repo: string,
  headSha: string
): string => {
  const file = error.filePath
    ? buildFileLink(error.filePath, error.line, owner, repo, headSha)
    : "_unknown_";
  const line = error.line ?? "-";
  const message = truncateMessage(error.message, 60);
  return `| ${file} | ${line} | ${message} |`;
};

// Helper: check if an error is uncertain (possibly test output or unknown pattern)
const isUncertainError = (error: ParsedError): boolean =>
  error.possiblyTestOutput === true || error.unknownPattern === true;

// Format the main PR comment with error summary
export const formatResultsComment = (options: FormatCommentOptions): string => {
  const { owner, repo, headSha, runs, errors } = options;
  const lines: string[] = [];

  // Separate errors into certain and uncertain
  const certainErrors = errors.filter((e) => !isUncertainError(e));
  const uncertainErrors = errors.filter(isUncertainError);

  // Header
  lines.push("## Detent CI Analysis");
  lines.push("");

  // Workflow summary table (only show if runs exist)
  if (runs.length > 0) {
    lines.push("| Workflow | Status | Errors |");
    lines.push("|----------|--------|--------|");
    for (const run of runs) {
      lines.push(formatWorkflowRow(run, owner, repo));
    }
    lines.push("");
  }

  // Certain errors section (top 10)
  if (certainErrors.length > 0) {
    const displayCount = Math.min(certainErrors.length, 10);
    const totalCertain = certainErrors.length;
    lines.push(`### Top Errors (${displayCount} of ${totalCertain})`);
    lines.push("");
    lines.push("| File | Line | Message | Source |");
    lines.push("|------|------|---------|--------|");

    for (const error of certainErrors.slice(0, 10)) {
      lines.push(formatErrorRow(error, owner, repo, headSha));
    }
    lines.push("");
  } else if (uncertainErrors.length === 0) {
    lines.push("### No errors found");
    lines.push("");
  }

  // Uncertain errors section (possibly test output or unknown pattern)
  if (uncertainErrors.length > 0) {
    lines.push("### Possibly Test Console Output");
    lines.push(
      "_The following may be captured from test mocks, not actual errors:_"
    );
    lines.push("");
    lines.push("| File | Line | Message |");
    lines.push("|------|------|---------|");

    for (const error of uncertainErrors.slice(0, 10)) {
      lines.push(formatUncertainErrorRow(error, owner, repo, headSha));
    }
    if (uncertainErrors.length > 10) {
      lines.push(
        `| ... | ... | _${uncertainErrors.length - 10} more uncertain errors_ |`
      );
    }
    lines.push("");
  }

  // Footer with CLI commands
  lines.push("---");
  lines.push("");
  lines.push(
    `**Full list:** \`detent errors --commit ${headSha.slice(0, 7)}\``
  );
  lines.push("**Auto-fix:** Comment `@detent heal` to attempt fixes");

  return lines.join("\n");
};

// Format the check run summary (shorter, for the checks UI)
export const formatCheckSummary = (
  runs: WorkflowRunResult[],
  totalErrors: number
): string => {
  const failedRuns = runs.filter((r) => r.conclusion === "failure");

  const lines: string[] = [];

  if (failedRuns.length > 0) {
    lines.push(
      `**${failedRuns.length}** workflow${failedRuns.length !== 1 ? "s" : ""} failed`
    );
    lines.push(`**${totalErrors}** error${totalErrors !== 1 ? "s" : ""} found`);
  } else {
    lines.push("All workflows passed");
  }

  // Only show table if there are runs
  if (runs.length > 0) {
    lines.push("");
    lines.push("| Workflow | Status |");
    lines.push("|----------|--------|");
    for (const run of runs) {
      const icon = run.conclusion === "success" ? "✅" : "❌";
      // Escape workflow name to prevent table breakage
      const safeName = escapeTableCell(run.name);
      // Escape conclusion in case it contains special chars
      const safeConclusion = escapeTableCell(run.conclusion);
      lines.push(`| ${safeName} | ${icon} ${safeConclusion} |`);
    }
  }

  return lines.join("\n");
};
