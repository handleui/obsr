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
const PIPE_PATTERN = /\|/g;
const BACKTICK_PATTERN = /`/g;

// Helper: escape text for markdown table cells
// Pipe chars break table structure, backticks can interfere with inline code
const escapeTableCell = (text: string): string => {
  return text.replace(PIPE_PATTERN, "\\|").replace(BACKTICK_PATTERN, "\\`");
};

// Format the main PR comment with error summary (minimal format)
export const formatResultsComment = (options: FormatCommentOptions): string => {
  const { owner, repo, headSha, runs } = options;
  const lines: string[] = [];

  // Separate failed and passed runs
  const failedRuns = runs.filter((r) => r.conclusion === "failure");
  const passedCount = runs.filter((r) => r.conclusion === "success").length;

  // Table header
  lines.push("| Workflow | Status | Errors |");
  lines.push("|----------|--------|--------|");

  // Only show failed runs in the table
  for (const run of failedRuns) {
    const safeName = escapeTableCell(run.name);
    const link = `https://github.com/${owner}/${repo}/actions/runs/${run.id}`;
    lines.push(`| [${safeName}](${link}) | Failed | ${run.errorCount} |`);
  }

  lines.push("");

  // Footer: passed count · timestamp · CLI command
  const timestamp = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const passedText = passedCount > 0 ? `${passedCount} passed` : "";
  const cliCommand = `\`detent errors --commit ${headSha.slice(0, 7)}\``;
  const footerParts = [
    passedText,
    `Updated ${timestamp} UTC`,
    cliCommand,
  ].filter(Boolean);
  lines.push(footerParts.join(" · "));

  return lines.join("\n");
};

// GitHub Check Run Annotation type (matches API spec)
export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

// Enhanced check run output with summary, detailed text, and annotations
export interface CheckRunOutput {
  summary: string;
  text?: string;
  annotations?: CheckRunAnnotation[];
}

// Options for formatting check run output
export interface FormatCheckRunOptions {
  owner: string;
  repo: string;
  headSha: string;
  runs: WorkflowRunResult[];
  errors: ParsedError[];
  totalErrors: number;
}

// Whitespace pattern for message truncation
const WHITESPACE_PATTERN = /\s+/g;

// Helper: truncate and sanitize message for display
const truncateMessage = (message: string, maxLen = 80): string => {
  const clean = message.replace(WHITESPACE_PATTERN, " ").trim();
  const escaped = escapeTableCell(clean);
  if (escaped.length <= maxLen) {
    return escaped;
  }
  return `${escaped.slice(0, maxLen - 3)}...`;
};

// Helper: truncate file path for display
const truncatePath = (path: string, maxLen = 50): string => {
  if (path.length <= maxLen) {
    return path;
  }
  const parts = path.split("/");
  if (parts.length <= 2) {
    return `...${path.slice(-(maxLen - 3))}`;
  }
  return `.../${parts.slice(-2).join("/")}`;
};

// Format the check run output (detailed, for the checks UI)
// Returns summary (main content), text (error details), and annotations (inline)
export const formatCheckRunOutput = (
  options: FormatCheckRunOptions
): CheckRunOutput => {
  const { headSha, runs, errors, totalErrors } = options;
  const failedRuns = runs.filter((r) => r.conclusion === "failure");
  const passedCount = runs.filter((r) => r.conclusion === "success").length;

  // === SUMMARY: Workflow table (concise, shown in check panel) ===
  const summaryLines: string[] = [];

  // One-line stats
  if (failedRuns.length > 0) {
    const failedText = `${failedRuns.length} workflow${failedRuns.length !== 1 ? "s" : ""} failed`;
    const errorText = `${totalErrors} error${totalErrors !== 1 ? "s" : ""}`;
    const passedText = passedCount > 0 ? ` · ${passedCount} passed` : "";
    summaryLines.push(`${failedText} · ${errorText}${passedText}`);
  } else {
    summaryLines.push("All workflows passed");
  }

  // Workflow table (only failed)
  if (failedRuns.length > 0) {
    summaryLines.push("");
    summaryLines.push("| Workflow | Status | Errors |");
    summaryLines.push("|----------|--------|--------|");
    for (const run of failedRuns) {
      const safeName = escapeTableCell(run.name);
      summaryLines.push(`| ${safeName} | Failed | ${run.errorCount} |`);
    }
  }

  // If no errors, return just the summary
  if (totalErrors === 0) {
    return { summary: summaryLines.join("\n") };
  }

  // === TEXT: Error details (shown below summary) ===
  const textLines: string[] = [];

  // Top errors table (max 10)
  const displayErrors = errors.slice(0, 10);
  textLines.push("### Top Errors");
  textLines.push("");
  textLines.push("| File | Line | Message |");
  textLines.push("|------|------|---------|");

  for (const error of displayErrors) {
    const file = error.filePath ? truncatePath(error.filePath) : "_unknown_";
    const line = error.line ?? "-";
    const message = truncateMessage(error.message);
    textLines.push(`| ${file} | ${line} | ${message} |`);
  }

  if (totalErrors > 10) {
    textLines.push("");
    textLines.push(`_Showing 10 of ${totalErrors} errors_`);
  }

  // Footer with CLI command
  textLines.push("");
  textLines.push(
    `\`detent errors --commit ${headSha.slice(0, 7)}\` for full list`
  );

  // === ANNOTATIONS: Inline file annotations (max 50 per API call) ===
  const annotations: CheckRunAnnotation[] = [];
  const errorsWithPath = errors.filter((e) => e.filePath && e.line);

  for (const error of errorsWithPath.slice(0, 50)) {
    annotations.push({
      path: error.filePath as string,
      start_line: error.line as number,
      end_line: error.line as number,
      annotation_level: "failure",
      message: error.message.slice(0, 500), // API limit
      title: error.source ?? error.category ?? "Error",
    });
  }

  return {
    summary: summaryLines.join("\n"),
    text: textLines.join("\n"),
    annotations: annotations.length > 0 ? annotations : undefined,
  };
};

// Legacy format for backwards compatibility (simple string output)
export const formatCheckSummary = (
  runs: WorkflowRunResult[],
  totalErrors: number
): string => {
  const failedRuns = runs.filter((r) => r.conclusion === "failure");
  const passedCount = runs.filter((r) => r.conclusion === "success").length;

  const lines: string[] = [];

  if (failedRuns.length > 0) {
    const failedText = `${failedRuns.length} workflow${failedRuns.length !== 1 ? "s" : ""} failed`;
    const errorText = `${totalErrors} error${totalErrors !== 1 ? "s" : ""}`;
    const passedText = passedCount > 0 ? ` · ${passedCount} passed` : "";
    lines.push(`${failedText} · ${errorText}${passedText}`);
  } else {
    lines.push("All workflows passed");
  }

  if (failedRuns.length > 0) {
    lines.push("");
    lines.push("| Workflow | Status | Errors |");
    lines.push("|----------|--------|--------|");
    for (const run of failedRuns) {
      const safeName = escapeTableCell(run.name);
      lines.push(`| ${safeName} | Failed | ${run.errorCount} |`);
    }
  }

  return lines.join("\n");
};
