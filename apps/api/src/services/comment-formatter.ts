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
      // Escape workflow name to prevent table breakage
      const safeName = escapeTableCell(run.name);
      // Capitalize status for display
      const status = run.conclusion === "success" ? "Passed" : "Failed";
      lines.push(`| ${safeName} | ${status} |`);
    }
  }

  return lines.join("\n");
};
