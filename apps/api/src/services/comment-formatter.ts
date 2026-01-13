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
  /** First line of the commit message (for display in footer) */
  headCommitMessage?: string;
  runs: WorkflowRunResult[];
  errors: ParsedError[];
  totalErrors: number;
  /** Unsupported tools detected from step commands */
  detectedUnsupportedTools?: string[];
  /** Detent check run ID for linking to parsed error summary */
  checkRunId?: number;
}

// Top-level regex for performance (avoid creating in loops)
const PIPE_PATTERN = /\|/g;
const BACKTICK_PATTERN = /`/g;
const NEWLINE_PATTERN = /[\r\n]+/g;
const HTML_TAG_PATTERN = /[<>&"']/g;
const BRACKET_OPEN_PATTERN = /\[/g;
const BRACKET_CLOSE_PATTERN = /\]/g;

// GitHub Check Run API limits
// See: https://docs.github.com/en/rest/checks/runs
const ANNOTATION_LIMITS = {
  MAX_PER_REQUEST: 50, // Can call update multiple times to add more
  MESSAGE_MAX_BYTES: 65_536, // 64 KB
  TITLE_MAX_CHARS: 255,
  RAW_DETAILS_MAX_BYTES: 65_536, // 64 KB
} as const;

// Check run output field limits (per GitHub API docs)
// API maximum is 65535 chars; we use slightly lower to avoid edge cases
const OUTPUT_LIMITS = {
  SUMMARY_MAX_CHARS: 65_000,
  TEXT_MAX_CHARS: 65_000,
} as const;

// Practical limit for annotation messages (readability in UI)
// API allows 64 KB but that's excessive for error messages
const ANNOTATION_MESSAGE_PRACTICAL_LIMIT = 4096;

// HTML entity map for escaping (hoisted for performance)
// Note: & must be listed first conceptually (though replace() handles this correctly)
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Helper: escape HTML entities for safe insertion into HTML contexts
// Prevents XSS via user-controlled content in <details>, <summary>, etc.
const escapeHtml = (text: string): string => {
  return text.replace(HTML_TAG_PATTERN, (char) => HTML_ENTITIES[char] ?? char);
};

// Helper: escape text for markdown table cells
// Pipe chars break table structure, backticks can interfere with inline code
// Newlines break table rows, brackets can create links
const escapeTableCell = (text: string): string => {
  return text
    .replace(NEWLINE_PATTERN, " ") // Newlines break table rows
    .replace(PIPE_PATTERN, "\\|")
    .replace(BACKTICK_PATTERN, "\\`")
    .replace(BRACKET_OPEN_PATTERN, "\\[") // Prevent markdown link injection
    .replace(BRACKET_CLOSE_PATTERN, "\\]");
};

// Helper: escape text for markdown link text [text](url)
// Combines HTML entity escaping (XSS prevention) with bracket escaping (link syntax)
// e.g., "src/test[1].ts" becomes "src/test\[1\].ts"
// e.g., "<script>" becomes "&lt;script&gt;"
const escapeMarkdownLinkText = (text: string): string => {
  return escapeHtml(text)
    .replace(BRACKET_OPEN_PATTERN, "\\[")
    .replace(BRACKET_CLOSE_PATTERN, "\\]");
};

// Format UTC timestamp in ISO-like format (internationally unambiguous)
// Format: "Jan 12, 15:30" - uses short month name + 24h time
const formatTimestamp = (date: Date): string => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${minutes}`;
};

// Detent documentation URL for comment headers
const DOCS_URL = "https://detent.dev/docs";

// Format friendly header with context-specific message
// Each comment type gets a different first line, but all share the docs link
const formatHeader = (message: string): string => {
  return `${message}\nNot sure what's happening? [Read the docs](${DOCS_URL})`;
};

// Maximum number of unsupported tools to display before truncating
const MAX_UNSUPPORTED_TOOLS_TO_DISPLAY = 10;

// Format unsupported tools notice for display in comments
const formatUnsupportedToolsNotice = (
  tools: string[] | undefined
): string | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  // Truncate long lists to avoid excessively long notices
  if (tools.length > MAX_UNSUPPORTED_TOOLS_TO_DISPLAY) {
    const displayed = tools.slice(0, MAX_UNSUPPORTED_TOOLS_TO_DISPLAY);
    const remaining = tools.length - MAX_UNSUPPORTED_TOOLS_TO_DISPLAY;
    return `_Detected ${displayed.join(", ")} (+${remaining} more) - parsers not yet available_`;
  }

  return `_Detected ${tools.join(", ")} - parsers not yet available_`;
};

// Group errors by workflow job and step for display
interface StepErrors {
  step: string;
  errorCount: number;
}

interface JobErrors {
  job: string;
  steps: StepErrors[];
  totalErrors: number;
}

// Group errors by job > step for the PR comment
const groupErrorsByJobAndStep = (errors: ParsedError[]): JobErrors[] => {
  const jobMap = new Map<string, Map<string, number>>();

  for (const error of errors) {
    const job = error.workflowJob ?? "Unknown";
    const step = error.workflowStep ?? "Unknown step";

    if (!jobMap.has(job)) {
      jobMap.set(job, new Map());
    }
    const stepMap = jobMap.get(job) as Map<string, number>;
    stepMap.set(step, (stepMap.get(step) ?? 0) + 1);
  }

  // Convert to array and sort by total errors (descending)
  const result: JobErrors[] = [];
  for (const [job, stepMap] of jobMap) {
    const steps: StepErrors[] = [];
    let totalErrors = 0;
    for (const [step, count] of stepMap) {
      steps.push({ step, errorCount: count });
      totalErrors += count;
    }
    // Sort steps by error count (descending)
    steps.sort((a, b) => b.errorCount - a.errorCount);
    result.push({ job, steps, totalErrors });
  }

  // Sort jobs by total errors (descending)
  result.sort((a, b) => b.totalErrors - a.totalErrors);
  return result;
};

// Format detailed job/step breakdown (when errors have job/step info)
const formatDetailedJobErrors = (
  lines: string[],
  jobErrors: JobErrors[]
): void => {
  for (const jobGroup of jobErrors) {
    const safeJob = escapeHtml(jobGroup.job);
    lines.push(`**${safeJob}**`);

    for (const stepGroup of jobGroup.steps) {
      const safeStep = escapeHtml(stepGroup.step);
      const errorText =
        stepGroup.errorCount === 1
          ? "1 error"
          : `${stepGroup.errorCount} errors`;
      lines.push(`- **${safeStep}** · ${errorText}`);
    }

    lines.push("");
  }
};

// Format fallback run-level errors (when errors lack job/step info)
const formatFallbackRunErrors = (
  lines: string[],
  failedRuns: WorkflowRunResult[]
): void => {
  for (const run of failedRuns) {
    const safeJob = escapeHtml(run.name);
    const errorText =
      run.errorCount === 1 ? "1 error" : `${run.errorCount} errors`;
    lines.push(`- **${safeJob}** · ${errorText}`);
  }
  lines.push("");
};

// Truncate commit message to first line and max length
const truncateCommitMessage = (message: string, maxLen = 50): string => {
  const firstLine = message.split("\n")[0] ?? message;
  if (firstLine.length <= maxLen) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLen - 1)}…`;
};

// Format the main PR comment with error summary (list format with job + step)
// Returns null if there are no failed workflows (caller should not post comment)
export const formatResultsComment = (
  options: FormatCommentOptions
): string | null => {
  const { owner, repo, headSha, headCommitMessage, runs, errors, checkRunId } =
    options;

  const failedRuns = runs.filter((r) => r.conclusion === "failure");
  const passedCount = runs.filter((r) => r.conclusion === "success").length;
  const otherCount = runs.filter(
    (r) => r.conclusion !== "failure" && r.conclusion !== "success"
  ).length;

  if (failedRuns.length === 0) {
    return null;
  }

  const lines: string[] = [];
  const shortSha = headSha.slice(0, 7);

  // Detent header - error context
  lines.push(formatHeader("Detent found some issues in your CI."));
  lines.push("");

  // CI status line with view link and CLI command
  const statusParts: string[] = ["CI"];
  if (checkRunId) {
    statusParts.push(
      `[view](https://github.com/${owner}/${repo}/runs/${checkRunId})`
    );
  }
  statusParts.push(`\`dt errors --commit ${shortSha}\``);
  lines.push(statusParts.join(" · "));
  lines.push("");

  // Job/step breakdown
  const jobErrors = groupErrorsByJobAndStep(errors);
  if (jobErrors.length > 0) {
    formatDetailedJobErrors(lines, jobErrors);
  } else {
    formatFallbackRunErrors(lines, failedRuns);
  }

  // Footer with timestamp and commit info
  const footerParts: string[] = [];
  if (passedCount > 0) {
    footerParts.push(`${passedCount} passed`);
  }
  if (otherCount > 0) {
    footerParts.push(`${otherCount} skipped`);
  }
  footerParts.push(`${formatTimestamp(new Date())} UTC`);

  // Show commit SHA with message if available
  if (headCommitMessage) {
    const truncatedMsg = truncateCommitMessage(headCommitMessage);
    footerParts.push(`\`${shortSha}\` ${truncatedMsg}`);
  } else {
    footerParts.push(`\`${shortSha}\``);
  }

  lines.push(footerParts.join(" · "));

  const unsupportedNotice = formatUnsupportedToolsNotice(
    options.detectedUnsupportedTools
  );
  if (unsupportedNotice) {
    lines.push("");
    lines.push(unsupportedNotice);
  }

  return lines.join("\n");
};

// Options for formatting a "passing" comment (when all checks pass)
export interface FormatPassingCommentOptions {
  runs: WorkflowRunResult[];
  headSha: string;
  /** First line of the commit message */
  headCommitMessage?: string;
}

// Format a "passing" comment to update an existing failure comment when all checks pass.
// This replaces the failure table with a success message while preserving the comment.
export const formatPassingComment = (
  options: FormatPassingCommentOptions
): string => {
  const { runs, headSha, headCommitMessage } = options;
  const shortSha = headSha.slice(0, 7);

  const passedCount = runs.filter((r) => r.conclusion === "success").length;
  const otherCount = runs.filter(
    (r) => r.conclusion !== "failure" && r.conclusion !== "success"
  ).length;

  const lines: string[] = [];

  // Detent header - success context
  lines.push(formatHeader("All clear! Nothing to fix here."));
  lines.push("");

  lines.push("✓ All checks passed");
  lines.push("");

  // Footer: passed count · skipped count · timestamp · commit
  const footerParts: string[] = [];

  if (passedCount > 0) {
    footerParts.push(`${passedCount} passed`);
  }
  if (otherCount > 0) {
    footerParts.push(`${otherCount} skipped`);
  }
  footerParts.push(`Updated ${formatTimestamp(new Date())} UTC`);

  // Show commit SHA with message if available
  if (headCommitMessage) {
    const truncatedMsg = truncateCommitMessage(headCommitMessage);
    footerParts.push(`\`${shortSha}\` ${truncatedMsg}`);
  } else {
    footerParts.push(`\`${shortSha}\``);
  }

  lines.push(footerParts.join(" · "));

  return lines.join("\n");
};

// GitHub Check Run Annotation type (matches API spec)
// See: https://docs.github.com/en/rest/checks/runs#update-a-check-run
//
// API Limits (per annotation):
// - message: 64 KB max
// - title: 255 characters max
// - raw_details: 64 KB max
// - Maximum 50 annotations per API request (can call update multiple times to add more)
//
// Annotation levels:
// - "failure": Blocks PR merging (if branch protection requires checks)
// - "warning": Shows warning icon, does not block
// - "notice": Informational, does not block
export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  raw_details?: string;
}

// Enhanced check run output with summary, detailed text, and annotations
// API Limits:
// - summary: 65535 characters max (supports Markdown)
// - text: 65535 characters max (supports Markdown)
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
  /** Unsupported tools detected from step commands */
  detectedUnsupportedTools?: string[];
}

// Whitespace pattern for message truncation
const WHITESPACE_PATTERN = /\s+/g;

// Helper: truncate and sanitize message for display
const truncateMessage = (message: string, maxLen = 500): string => {
  const clean = message.replace(WHITESPACE_PATTERN, " ").trim();
  const escaped = escapeTableCell(clean);
  if (escaped.length <= maxLen) {
    return escaped;
  }
  return `${escaped.slice(0, maxLen - 3)}...`;
};

// Helper: truncate file path for display (returns unescaped path)
// Caller must apply appropriate escaping (escapeHtml or escapeTableCell)
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

// === ANNOTATION HELPERS ===

// Map ParsedError severity to GitHub annotation level
// "error" -> failure (red X), "warning" -> warning (yellow), else -> notice (blue info)
const mapSeverityToAnnotationLevel = (
  severity?: string
): "notice" | "warning" | "failure" => {
  switch (severity?.toLowerCase()) {
    case "error":
    case "fatal":
    case "critical":
      return "failure";
    case "warning":
    case "warn":
      return "warning";
    case "info":
    case "note":
    case "hint":
    case "suggestion":
      return "notice";
    default:
      // Default to failure for unknown severity (most CI errors should block)
      return "failure";
  }
};

// Priority scoring for errors - higher = more actionable, should appear first
// Returns numeric score (higher = more important)
const calculateErrorPriority = (error: ParsedError): number => {
  let score = 0;

  // Has file path - more actionable (+100)
  if (error.filePath) {
    score += 100;
  }

  // Has line number - even more actionable (+50)
  if (error.line) {
    score += 50;
  }

  // Has column - most precise (+20)
  if (error.column) {
    score += 20;
  }

  // Severity weight
  switch (error.severity?.toLowerCase()) {
    case "error":
    case "fatal":
    case "critical":
      score += 30;
      break;
    case "warning":
    case "warn":
      score += 20;
      break;
    default:
      score += 10;
  }

  // Has rule ID - can be looked up (+15)
  if (error.ruleId) {
    score += 15;
  }

  // Has hint/suggestion - actionable (+10)
  if (error.hint) {
    score += 10;
  }

  // Penalize unknown patterns and test output noise
  // Use moderate penalty (-20) for unknownPattern since they're real errors
  // that just didn't match a known parser - still actionable
  if (error.unknownPattern) {
    score -= 20;
  }
  if (error.possiblyTestOutput) {
    score -= 50;
  }

  // Source-based priority (well-known tools get boost)
  const knownSources = [
    "typescript",
    "eslint",
    "biome",
    "rust",
    "go",
    "python",
  ];
  if (error.source && knownSources.includes(error.source.toLowerCase())) {
    score += 10;
  }

  return score;
};

// Create a unique key for error deduplication (file:line)
// Uses sentinel values that won't collide with real paths/lines:
// - "__no_path__" instead of "unknown" (real files could be named "unknown")
// - "__no_line__" instead of 0 (real errors can occur at line 0)
const createErrorKey = (error: ParsedError): string => {
  return `${error.filePath ?? "__no_path__"}:${error.line ?? "__no_line__"}`;
};

// Deduplicated error with combined messages from same location
interface DeduplicatedError extends ParsedError {
  combinedMessages?: string[];
  originalCount?: number;
}

// Merge a new error into an existing deduplicated error
const mergeIntoExisting = (
  existing: DeduplicatedError,
  error: ParsedError
): void => {
  // Initialize combined messages if needed
  if (!existing.combinedMessages) {
    existing.combinedMessages = [existing.message];
    existing.originalCount = 1;
  }

  // Add unique message
  if (!existing.combinedMessages.includes(error.message)) {
    existing.combinedMessages.push(error.message);
    existing.originalCount = (existing.originalCount ?? 1) + 1;
  }

  // Keep higher severity (failure > warning > notice)
  // Numeric mapping: failure=2, warning=1, notice=0
  const severityRank = { failure: 2, warning: 1, notice: 0 } as const;
  const newLevel = mapSeverityToAnnotationLevel(error.severity);
  const existingLevel = mapSeverityToAnnotationLevel(existing.severity);
  if (severityRank[newLevel] > severityRank[existingLevel]) {
    existing.severity = error.severity;
  }

  // Merge metadata (keep first non-empty value)
  existing.ruleId = existing.ruleId ?? error.ruleId;
  existing.hint = existing.hint ?? error.hint;
  existing.source = existing.source ?? error.source;
};

// Deduplicate errors at same file:line by combining messages
// Returns deduplicated errors with combined messages
const deduplicateErrors = (errors: ParsedError[]): DeduplicatedError[] => {
  const errorMap = new Map<string, DeduplicatedError>();

  for (const error of errors) {
    const key = createErrorKey(error);
    const existing = errorMap.get(key);

    if (existing) {
      mergeIntoExisting(existing, error);
    } else {
      errorMap.set(key, { ...error });
    }
  }

  return Array.from(errorMap.values());
};

// Capitalize first letter of source name for display
const capitalizeSource = (source: string): string => {
  if (!source) {
    return source;
  }
  // Handle known sources with preferred casing
  const knownSources: Record<string, string> = {
    typescript: "TypeScript",
    eslint: "ESLint",
    biome: "Biome",
    "go-test": "Go Test",
    go: "Go",
    rust: "Rust",
    python: "Python",
    docker: "Docker",
    nodejs: "Node.js",
  };
  return knownSources[source.toLowerCase()] ?? source;
};

// Get short source badge for inline display (e.g., "TS", "Biome")
const getSourceBadge = (source?: string): string => {
  if (!source) {
    return "";
  }
  const badges: Record<string, string> = {
    typescript: "TS",
    eslint: "ESLint",
    biome: "Biome",
    "go-test": "Go",
    go: "Go",
    rust: "Rust",
    python: "Py",
    docker: "Docker",
    nodejs: "Node",
  };
  return badges[source.toLowerCase()] ?? source;
};

// Generate GitHub blob URL for a file (URL-encodes the path)
const generateFileUrl = (
  owner: string,
  repo: string,
  sha: string,
  filePath: string
): string => {
  // URL-encode the file path to handle special characters
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${owner}/${repo}/blob/${sha}/${encodedPath}`;
};

// === GROUPING HELPERS ===

interface ErrorsByFile {
  filePath: string;
  errors: ParsedError[];
}

// Group errors by file path
// Sorts file paths alphabetically, errors within each file by line number
const groupErrorsByFile = (errors: ParsedError[]): ErrorsByFile[] => {
  const grouped = new Map<string, ParsedError[]>();

  for (const error of errors) {
    const filePath = error.filePath ?? "__no_path__";
    const existing = grouped.get(filePath) ?? [];
    existing.push(error);
    grouped.set(filePath, existing);
  }

  // Sort file paths alphabetically, errors within each file by line number
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, errs]) => ({
      filePath,
      errors: errs.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    }));
};

// Options for formatting the text section
interface FormatTextSectionOptions {
  owner: string;
  repo: string;
  headSha: string;
  errors: ParsedError[];
}

// Maximum files to show inline before collapsing
const MAX_INLINE_FILES = 10;

// Format the text section with errors grouped by file (flat list, no dropdowns)
const formatTextSection = (options: FormatTextSectionOptions): string[] => {
  const { owner, repo, headSha, errors } = options;
  const lines: string[] = [];

  // Annotation note at top
  const annotatableCount = errors.filter(
    (e) => e.filePath && e.line && !e.possiblyTestOutput
  ).length;
  if (annotatableCount > 0) {
    lines.push(
      `*${annotatableCount} error${annotatableCount === 1 ? "" : "s"} annotated inline where possible*`
    );
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Group all errors by file (no source grouping)
  const byFile = groupErrorsByFile(errors);

  // Split into visible files and overflow files
  const visibleFiles = byFile.slice(0, MAX_INLINE_FILES);
  const overflowFiles = byFile.slice(MAX_INLINE_FILES);

  // Format visible files
  for (const fileGroup of visibleFiles) {
    formatFileGroup(lines, fileGroup, owner, repo, headSha);
  }

  // Format overflow files in a single collapsible section
  if (overflowFiles.length > 0) {
    lines.push("<details>");
    lines.push(`<summary>View ${overflowFiles.length} more files</summary>`);
    lines.push("");

    for (const fileGroup of overflowFiles) {
      formatFileGroup(lines, fileGroup, owner, repo, headSha);
    }

    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines;
};

// Format a single file group as a flat bullet list
const formatFileGroup = (
  lines: string[],
  fileGroup: ErrorsByFile,
  owner: string,
  repo: string,
  headSha: string
): void => {
  const filePath = fileGroup.filePath;
  const isUnknownPath = filePath === "__no_path__";

  // File header with link (unless it's an unknown path)
  if (isUnknownPath) {
    lines.push("**Unknown location**");
  } else {
    const fileUrl = generateFileUrl(owner, repo, headSha, filePath);
    const displayPath = escapeMarkdownLinkText(truncatePath(filePath, 80));
    lines.push(`**[${displayPath}](${fileUrl})**`);
  }

  // Error bullet list
  for (const error of fileGroup.errors) {
    const lineNum = error.line ?? "-";
    const badge = getSourceBadge(error.source);
    const badgeText = badge ? `[${badge}] ` : "";
    const message = truncateMessage(error.message, 300);
    lines.push(`- \`${lineNum}\` ${badgeText}${message}`);
  }

  lines.push("");
};

// Generate annotation title from source name (e.g., "TypeScript", "Biome")
const generateAnnotationTitle = (error: DeduplicatedError): string => {
  const title = error.source ? capitalizeSource(error.source) : "Error";
  return title.length > ANNOTATION_LIMITS.TITLE_MAX_CHARS
    ? `${title.slice(0, ANNOTATION_LIMITS.TITLE_MAX_CHARS - 3)}...`
    : title;
};

// Create CheckRunAnnotation from ParsedError
const createAnnotation = (error: DeduplicatedError): CheckRunAnnotation => {
  // Build the main message
  let message = error.message;

  // If multiple errors combined, include them in message
  if (error.combinedMessages && error.combinedMessages.length > 1) {
    if (error.combinedMessages.length <= 3) {
      // Show all messages inline for small counts
      message = error.combinedMessages.join("\n\n");
    } else {
      // Summarize for larger counts
      message = `${error.message}\n\n(+${error.combinedMessages.length - 1} more issues at this location)`;
    }
  }

  // Add hint inline if short enough and no multiple messages
  if (error.hint && error.hint.length < 100 && !error.combinedMessages) {
    message = `${message}\n\nHint: ${error.hint}`;
  }

  // Truncate message (API allows 64 KB but keep it readable)
  if (message.length > ANNOTATION_MESSAGE_PRACTICAL_LIMIT) {
    message = `${message.slice(0, ANNOTATION_MESSAGE_PRACTICAL_LIMIT - 3)}...`;
  }

  // Determine annotation level from severity, but downgrade unknownPattern to notice
  // (lower confidence errors from generic fallback parser shouldn't block PRs)
  let annotationLevel = mapSeverityToAnnotationLevel(error.severity);
  if (error.unknownPattern) {
    annotationLevel = "notice";
  }

  const annotation: CheckRunAnnotation = {
    path: error.filePath as string,
    start_line: error.line as number,
    end_line: error.line as number,
    annotation_level: annotationLevel,
    message,
    title: generateAnnotationTitle(error),
  };

  // Add column if available (for single-line precision)
  if (error.column) {
    annotation.start_column = error.column;
    annotation.end_column = error.column;
  }

  return annotation;
};

// Format the check run output (detailed, for the checks UI)
// Returns summary (main content), text (error details), and annotations (inline)
export const formatCheckRunOutput = (
  options: FormatCheckRunOptions
): CheckRunOutput => {
  const { owner, repo, headSha, runs, errors, totalErrors } = options;
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

  // Add unsupported tools notice to summary if any detected
  const unsupportedNotice = formatUnsupportedToolsNotice(
    options.detectedUnsupportedTools
  );
  if (unsupportedNotice) {
    summaryLines.push("");
    summaryLines.push(unsupportedNotice);
  }

  // If no errors, return just the summary
  if (totalErrors === 0) {
    return { summary: summaryLines.join("\n") };
  }

  // === TEXT: Error details (shown below summary) ===
  // Cap at 200 errors for reasonable output size
  const maxDisplayErrors = 200;
  const displayErrors = errors.slice(0, maxDisplayErrors);
  const textLines = formatTextSection({
    owner,
    repo,
    headSha,
    errors: displayErrors,
  });

  // Show truncation note if errors were capped
  if (errors.length > maxDisplayErrors) {
    textLines.push("");
    textLines.push(`_Showing ${maxDisplayErrors} of ${errors.length} errors_`);
  }

  // Footer with CLI command
  textLines.push(`\`dt errors --commit ${headSha.slice(0, 7)}\` for full list`);

  let text = textLines.join("\n");

  // Ensure we don't exceed GitHub's text field limit (65535 chars)
  if (text.length > OUTPUT_LIMITS.TEXT_MAX_CHARS) {
    text = `${text.slice(0, OUTPUT_LIMITS.TEXT_MAX_CHARS - 500)}\n\n_Output truncated due to size limits_`;
  }

  // === ANNOTATIONS: Inline file annotations ===
  // Sort errors by priority (most actionable first) for annotations
  const sortedErrors = [...errors].sort(
    (a, b) => calculateErrorPriority(b) - calculateErrorPriority(a)
  );

  // Filter to errors with file path and line number (required for annotations)
  // Also filter out test output noise (vitest/jest progress, etc.)
  const errorsWithPath = sortedErrors.filter(
    (e) => e.filePath && e.line && !e.possiblyTestOutput
  );

  // Deduplicate errors at same file:line to reduce annotation noise
  // Note: Order is preserved because:
  // 1. Input is already sorted by priority (highest first)
  // 2. Map preserves insertion order
  // 3. First error at each file:line has highest priority for that location
  const deduplicatedErrors = deduplicateErrors(errorsWithPath);

  // Create annotations using helper (max 50 per request)
  // Helper handles: severity-based levels, rich titles, raw_details, column info
  const annotations = deduplicatedErrors
    .slice(0, ANNOTATION_LIMITS.MAX_PER_REQUEST)
    .map(createAnnotation);

  // Build summary and ensure it doesn't exceed GitHub's limit
  let summary = summaryLines.join("\n");
  if (summary.length > OUTPUT_LIMITS.SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, OUTPUT_LIMITS.SUMMARY_MAX_CHARS - 100)}\n\n_Summary truncated_`;
  }

  return {
    summary,
    text,
    annotations: annotations.length > 0 ? annotations : undefined,
  };
};

// Options for formatting a "waiting" comment (when CI is still running)
export interface FormatWaitingCommentOptions {
  headSha: string;
  /** First line of the commit message */
  headCommitMessage?: string;
}

// Format a "waiting" comment posted immediately when a PR is created.
// This comment is updated with actual results when CI completes.
export const formatWaitingComment = (
  options: FormatWaitingCommentOptions
): string => {
  const { headSha, headCommitMessage } = options;
  const shortSha = headSha.slice(0, 7);

  const lines: string[] = [];

  // Detent header - waiting context
  lines.push(
    formatHeader(
      "Detent is watching this PR. When CI finishes, any errors will be summarized here."
    )
  );
  lines.push("");

  // Show which commit we're waiting on
  if (headCommitMessage) {
    const truncatedMsg = truncateCommitMessage(headCommitMessage);
    lines.push(`Waiting on \`${shortSha}\` ${truncatedMsg}`);
  } else {
    lines.push(`Waiting on \`${shortSha}\``);
  }

  return lines.join("\n");
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
