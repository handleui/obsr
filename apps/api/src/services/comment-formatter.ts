// Comment formatter for GitHub PR comments
// Formats error summaries in a clean, scannable format

import type { CIError } from "@detent/types";
import type { JobEvaluation, JobSummary } from "./github/workflow-jobs";
import type {
  WorkflowRunEvaluation,
  WorkflowRunSummary,
} from "./github/workflow-runs";

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
  errors: CIError[];
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
// Escapes both HTML entities (XSS prevention) and markdown table syntax
// Pipe chars break table structure, backticks can interfere with inline code
// Newlines break table rows, brackets can create links
// HTML entities must be escaped because markdown renderers can interpret HTML
const escapeTableCell = (text: string): string => {
  return escapeHtml(text)
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
const MONTHS = [
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

const formatTimestamp = (date: Date): string => {
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${minutes}`;
};

// Detent documentation URL for comment headers
const DOCS_URL = "https://detent.sh/docs";

// Format friendly header with context-specific message
// Each comment type gets a different first line, but all share the docs link
const formatHeader = (message: string): string => {
  return `${message}\nNot sure what's happening? [Read the docs](${DOCS_URL})`;
};

// Maximum number of unsupported tools to display before truncating
const MAX_UNSUPPORTED_TOOLS_TO_DISPLAY = 10;

// Format unsupported tools notice for display in comments
// Escapes tool names to prevent markdown/HTML injection from malicious step commands
const formatUnsupportedToolsNotice = (
  tools: string[] | undefined
): string | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  // Escape each tool name to prevent injection attacks
  // Tool names come from workflow step commands which could be attacker-controlled
  const escapedTools = tools.map((t) => escapeHtml(t));

  // Truncate long lists to avoid excessively long notices
  if (escapedTools.length > MAX_UNSUPPORTED_TOOLS_TO_DISPLAY) {
    const displayed = escapedTools.slice(0, MAX_UNSUPPORTED_TOOLS_TO_DISPLAY);
    const remaining = escapedTools.length - MAX_UNSUPPORTED_TOOLS_TO_DISPLAY;
    return `_Detected ${displayed.join(", ")} (+${remaining} more) - parsers not yet available_`;
  }

  return `_Detected ${escapedTools.join(", ")} - parsers not yet available_`;
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
const groupErrorsByJobAndStep = (errors: CIError[]): JobErrors[] => {
  const jobMap = new Map<string, Map<string, number>>();

  for (const error of errors) {
    const job = error.workflowJob ?? error.workflowContext?.job ?? "Unknown";
    // Check workflowContext.step first, fall back to legacy workflowStep field (from DB records)
    const step =
      error.workflowContext?.step ?? error.workflowStep ?? "Unknown step";

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
// Also escapes HTML entities to prevent XSS/markdown injection
const truncateCommitMessage = (message: string, maxLen = 50): string => {
  const firstLine = message.split("\n")[0] ?? message;
  // Escape HTML entities first (XSS prevention)
  const escaped = escapeHtml(firstLine);
  if (escaped.length <= maxLen) {
    return escaped;
  }
  return `${escaped.slice(0, maxLen - 1)}…`;
};

// Format the main PR comment with error summary (list format with job + step)
// Returns null if there are no failed workflows (caller should not post comment)
export const formatResultsComment = (
  options: FormatCommentOptions
): string | null => {
  const { owner, repo, headSha, headCommitMessage, runs, errors, checkRunId } =
    options;

  // Single-pass counting instead of multiple filter passes
  let passedCount = 0;
  let otherCount = 0;
  const failedRuns: WorkflowRunResult[] = [];
  for (const r of runs) {
    if (r.conclusion === "failure") {
      failedRuns.push(r);
    } else if (r.conclusion === "success") {
      passedCount++;
    } else {
      otherCount++;
    }
  }

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

  // Single-pass counting instead of multiple filter passes
  let passedCount = 0;
  let otherCount = 0;
  for (const r of runs) {
    if (r.conclusion === "success") {
      passedCount++;
    } else if (r.conclusion !== "failure") {
      otherCount++;
    }
  }

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
  errors: CIError[];
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

// Map CIError severity to GitHub annotation level
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

const PRIORITY_SOURCES = new Set([
  "typescript",
  "eslint",
  "biome",
  "rust",
  "go",
  "python",
]);

const KNOWN_SOURCE_NAMES = new Map([
  ["typescript", "TypeScript"],
  ["eslint", "ESLint"],
  ["biome", "Biome"],
  ["go-test", "Go Test"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["python", "Python"],
  ["docker", "Docker"],
  ["nodejs", "Node.js"],
]);

const SOURCE_BADGES = new Map([
  ["typescript", "TS"],
  ["eslint", "ESLint"],
  ["biome", "Biome"],
  ["go-test", "Go"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["python", "Py"],
  ["docker", "Docker"],
  ["nodejs", "Node"],
]);

// Priority scoring for errors - higher = more actionable, should appear first
// Returns numeric score (higher = more important)
const calculateErrorPriority = (error: CIError): number => {
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

  // Has hints - actionable (+10)
  if (error.hints && error.hints.length > 0) {
    score += 10;
  }

  if (error.source && PRIORITY_SOURCES.has(error.source.toLowerCase())) {
    score += 10;
  }

  return score;
};

// Create a unique key for error deduplication (file:line)
// Uses sentinel values that won't collide with real paths/lines:
// - "__no_path__" instead of "unknown" (real files could be named "unknown")
// - "__no_line__" instead of 0 (real errors can occur at line 0)
const createErrorKey = (error: CIError): string => {
  return `${error.filePath ?? "__no_path__"}:${error.line ?? "__no_line__"}`;
};

// Deduplicated error with combined messages from same location
interface DeduplicatedError extends CIError {
  combinedMessages?: string[];
  originalCount?: number;
}

// Merge a new error into an existing deduplicated error
const mergeIntoExisting = (
  existing: DeduplicatedError,
  error: CIError
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
  existing.hints = existing.hints ?? error.hints;
  existing.source = existing.source ?? error.source;
};

// Deduplicate errors at same file:line by combining messages
// Returns deduplicated errors with combined messages
// Performance: avoids spread copies by using Object.assign only for first occurrence
const deduplicateErrors = (errors: CIError[]): DeduplicatedError[] => {
  const errorMap = new Map<string, DeduplicatedError>();
  const result: DeduplicatedError[] = [];

  for (const error of errors) {
    const key = createErrorKey(error);
    const existing = errorMap.get(key);

    if (existing) {
      mergeIntoExisting(existing, error);
    } else {
      // Create shallow copy only for first occurrence at each location
      const deduped: DeduplicatedError = { ...error };
      errorMap.set(key, deduped);
      result.push(deduped);
    }
  }

  return result;
};

// Capitalize first letter of source name for display
const capitalizeSource = (source: string): string => {
  if (!source) {
    return source;
  }
  return KNOWN_SOURCE_NAMES.get(source.toLowerCase()) ?? source;
};

// Get short source badge for inline display (e.g., "TS", "Biome")
const getSourceBadge = (source?: string): string => {
  if (!source) {
    return "";
  }
  return SOURCE_BADGES.get(source.toLowerCase()) ?? source;
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
  errors: CIError[];
}

// Group errors by file path
// Sorts file paths alphabetically, errors within each file by line number
const groupErrorsByFile = (errors: CIError[]): ErrorsByFile[] => {
  const grouped = new Map<string, CIError[]>();

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
  errors: CIError[];
}

// Maximum files to show inline before collapsing
const MAX_INLINE_FILES = 10;

// Format the text section with errors grouped by file (flat list, no dropdowns)
const formatTextSection = (options: FormatTextSectionOptions): string[] => {
  const { owner, repo, headSha, errors } = options;
  const lines: string[] = [];

  // Count annotatable errors (single pass)
  let annotatableCount = 0;
  for (const e of errors) {
    if (e.filePath && e.line) {
      annotatableCount++;
    }
  }
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

// Create CheckRunAnnotation from CIError
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

  // Add first hint inline if short enough and no multiple messages
  const firstHint = error.hints?.[0];
  if (firstHint && firstHint.length < 100 && !error.combinedMessages) {
    message = `${message}\n\nHint: ${firstHint}`;
  }

  // Truncate message (API allows 64 KB but keep it readable)
  if (message.length > ANNOTATION_MESSAGE_PRACTICAL_LIMIT) {
    message = `${message.slice(0, ANNOTATION_MESSAGE_PRACTICAL_LIMIT - 3)}...`;
  }

  const annotationLevel = mapSeverityToAnnotationLevel(error.severity);

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

  // Single-pass counting instead of multiple filter passes
  const failedRuns: WorkflowRunResult[] = [];
  let passedCount = 0;
  for (const r of runs) {
    if (r.conclusion === "failure") {
      failedRuns.push(r);
    } else if (r.conclusion === "success") {
      passedCount++;
    }
  }

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
  // Filter first, then sort (smaller array to sort = better performance)
  // Filter to errors with file path and line number (required for annotations)
  const annotatableErrors = errors.filter((e) => e.filePath && e.line);

  // Sort by priority (most actionable first) for annotations
  annotatableErrors.sort(
    (a, b) => calculateErrorPriority(b) - calculateErrorPriority(a)
  );

  // Deduplicate errors at same file:line to reduce annotation noise
  // Note: Order is preserved because:
  // 1. Input is already sorted by priority (highest first)
  // 2. Map preserves insertion order
  // 3. First error at each file:line has highest priority for that location
  const deduplicatedErrors = deduplicateErrors(annotatableErrors);

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

// Options for formatting a "waiting" check run output (when CI is still running)
export interface FormatWaitingCheckRunOptions {
  /** Full workflow evaluation from evaluateWorkflowRuns */
  evaluation: WorkflowRunEvaluation;
  /** Optional: job-level details for in-progress workflows */
  jobsByRunId?: Map<number, JobEvaluation>;
}

// Helper: format duration from start time to now
const formatDuration = (startedAt: Date | null, nowMs: number): string => {
  if (!startedAt) {
    return "-";
  }
  const durationMs = nowMs - startedAt.getTime();
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
};

// Helper: format workflow status for display
const formatWorkflowStatus = (
  status: string,
  conclusion: string | null,
  isStuck: boolean
): string => {
  if (status === "completed") {
    if (conclusion === "success") {
      return "✓ passed";
    }
    if (conclusion === "failure") {
      return "✗ failed";
    }
    return conclusion ?? "done";
  }
  if (status === "in_progress") {
    return isStuck ? "(!) running (stuck?)" : "running";
  }
  return status; // queued, waiting, etc.
};

// Helper: format job status for display (similar to workflow status)
const formatJobStatus = (status: string, conclusion: string | null): string => {
  if (status === "completed") {
    if (conclusion === "success") {
      return "✓ passed";
    }
    if (conclusion === "failure") {
      return "✗ failed";
    }
    if (conclusion === "skipped") {
      return "skipped";
    }
    if (conclusion === "cancelled") {
      return "cancelled";
    }
    return conclusion ?? "done";
  }
  if (status === "in_progress") {
    return "running";
  }
  return status; // queued, waiting, etc.
};

// Maximum workflows to display in the waiting table before truncating
// Keeps output under GitHub's 65535 char limit even with long workflow names
const MAX_WORKFLOWS_IN_TABLE = 50;

// Helper: Build job table lines for a workflow run
const buildJobTableLines = (jobs: JobSummary[], nowMs: number): string[] => {
  const lines: string[] = [];
  lines.push("| Job | Status | Duration |");
  lines.push("|-----|--------|----------|");

  // Sort jobs: pending first, then completed
  const sortedJobs = [...jobs].sort((a, b) => {
    const aCompleted = a.status === "completed";
    const bCompleted = b.status === "completed";
    if (aCompleted !== bCompleted) {
      return aCompleted ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const job of sortedJobs) {
    const safeName = escapeTableCell(job.name);
    const statusText = formatJobStatus(job.status, job.conclusion);
    const duration = formatDuration(job.startedAt, nowMs);
    lines.push(`| ${safeName} | ${statusText} | ${duration} |`);
  }

  return lines;
};

// Helper: Count job progress across all runs
const countJobProgress = (
  jobsByRunId?: Map<number, JobEvaluation>
): { totalJobs: number; completedJobs: number } => {
  if (!jobsByRunId || jobsByRunId.size === 0) {
    return { totalJobs: 0, completedJobs: 0 };
  }
  let totalJobs = 0;
  let completedJobs = 0;
  for (const jobEval of jobsByRunId.values()) {
    totalJobs += jobEval.jobs.length;
    completedJobs += jobEval.jobs.length - jobEval.pendingJobs.length;
  }
  return { totalJobs, completedJobs };
};

// Helper: Build title based on progress
const buildTitle = (
  totalCount: number,
  totalJobs: number,
  completedJobs: number,
  completedCount: number
): string => {
  if (totalCount === 0) {
    return "Waiting for CI workflows...";
  }
  if (totalJobs > 0) {
    return `Waiting for CI (${completedJobs}/${totalJobs} jobs complete)`;
  }
  return `Waiting for CI (${completedCount}/${totalCount} complete)`;
};

// Helper: Build job tables section for pending CI runs
const buildJobTablesSection = (
  pendingCiRuns: WorkflowRunSummary[],
  ciRelevantRuns: WorkflowRunSummary[],
  jobsByRunId: Map<number, JobEvaluation>,
  completedCount: number,
  nowMs: number
): string[] => {
  const lines: string[] = [];

  // Show job table for each workflow with job data
  for (const run of pendingCiRuns) {
    const jobEval = jobsByRunId.get(run.id);
    if (jobEval && jobEval.jobs.length > 0) {
      lines.push(`**${escapeTableCell(run.name)}**`);
      lines.push("");
      lines.push(...buildJobTableLines(jobEval.jobs, nowMs));
      lines.push("");
    }
  }

  // Show completed workflows summary
  if (completedCount > 0) {
    const completedNames = ciRelevantRuns
      .filter((r) => r.status === "completed")
      .map((r) => escapeTableCell(r.name))
      .slice(0, 5)
      .join(", ");
    const moreCount = completedCount > 5 ? ` +${completedCount - 5} more` : "";
    lines.push(`_Completed: ${completedNames}${moreCount}_`);
  }

  return lines;
};

// Helper: Build footer stats lines
const buildFooterStats = (
  totalJobs: number,
  totalCount: number,
  stuckRuns: WorkflowRunSummary[],
  skippedRuns: WorkflowRunSummary[],
  blacklistedRuns: WorkflowRunSummary[]
): string[] => {
  const lines: string[] = [];
  lines.push("");

  const statsLine: string[] =
    totalJobs > 0
      ? [`${totalJobs} jobs tracked`]
      : [`${totalCount} workflows tracked`];
  if (stuckRuns.length > 0) {
    statsLine.push(`${stuckRuns.length} may be stuck (>30m)`);
  }
  lines.push(statsLine.join(" · "));

  // Show skipped workflows (non-CI events)
  if (skippedRuns.length > 0) {
    const skippedList = skippedRuns
      .slice(0, 5)
      .map((r) => `${escapeTableCell(r.name)} (${escapeTableCell(r.event)})`)
      .join(", ");
    const moreCount =
      skippedRuns.length > 5 ? ` +${skippedRuns.length - 5} more` : "";
    lines.push(`_Skipped: ${skippedList}${moreCount}_`);
  }

  // Show blacklisted workflows
  if (blacklistedRuns.length > 0) {
    const blacklistNames = blacklistedRuns
      .slice(0, 3)
      .map((r) => escapeTableCell(r.name))
      .join(", ");
    const moreCount =
      blacklistedRuns.length > 3 ? ` +${blacklistedRuns.length - 3} more` : "";
    lines.push(`_Excluded: ${blacklistNames}${moreCount}_`);
  }

  return lines;
};

// Helper: Build workflow table lines
const buildWorkflowTableLines = (
  ciRelevantRuns: WorkflowRunSummary[],
  stuckRuns: WorkflowRunSummary[],
  nowMs: number
): { lines: string[]; truncatedCount: number } => {
  const lines: string[] = [];
  lines.push("| Workflow | Status | Duration |");
  lines.push("|----------|--------|----------|");

  // Sort: pending first, then completed
  const sortedRuns = [...ciRelevantRuns].sort((a, b) => {
    const aCompleted = a.status === "completed";
    const bCompleted = b.status === "completed";
    if (aCompleted !== bCompleted) {
      return aCompleted ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  // Build a set of stuck workflow names for O(1) lookup
  const stuckNames = new Set(stuckRuns.map((r) => r.name));

  // Limit table rows to prevent exceeding GitHub's output limits
  const displayRuns = sortedRuns.slice(0, MAX_WORKFLOWS_IN_TABLE);
  const truncatedCount = sortedRuns.length - displayRuns.length;

  for (const run of displayRuns) {
    const safeName = escapeTableCell(run.name);
    const isStuck = stuckNames.has(run.name);
    const statusText = formatWorkflowStatus(
      run.status,
      run.conclusion,
      isStuck
    );
    const duration = formatDuration(run.runStartedAt, nowMs);
    lines.push(`| ${safeName} | ${statusText} | ${duration} |`);
  }

  return { lines, truncatedCount };
};

// Helper: Build summary for when no CI-relevant workflows are found
const buildNoWorkflowsSummary = (
  blacklistedRuns: WorkflowRunSummary[],
  skippedRuns: WorkflowRunSummary[]
): string => {
  const filteredCount = blacklistedRuns.length + skippedRuns.length;

  // Case 1: No workflows at all yet
  if (filteredCount === 0) {
    return [
      "Detent will analyze CI results once all workflows finish.",
      "",
      "_Waiting for CI workflows to start..._",
    ].join("\n");
  }

  // Case 2: Workflows exist but all were filtered
  const lines = [
    "Detent will analyze CI results once all workflows finish.",
    "",
    `_No CI-relevant workflows found (${filteredCount} filtered)._`,
    "",
  ];

  if (blacklistedRuns.length > 0) {
    const names = blacklistedRuns
      .slice(0, 3)
      .map((r) => escapeTableCell(r.name))
      .join(", ");
    const more =
      blacklistedRuns.length > 3 ? ` +${blacklistedRuns.length - 3} more` : "";
    lines.push(`_Excluded: ${names}${more}_`);
  }

  if (skippedRuns.length > 0) {
    const names = skippedRuns
      .slice(0, 3)
      .map((r) => `${escapeTableCell(r.name)} (${r.event})`)
      .join(", ");
    const more =
      skippedRuns.length > 3 ? ` +${skippedRuns.length - 3} more` : "";
    lines.push(`_Non-CI events: ${names}${more}_`);
  }

  return lines.join("\n");
};

// Format a "waiting" check run output with job tracking visibility
// Shows which workflows are being tracked and their current status
// When job data is available, shows job-level progress for better visibility
export const formatWaitingCheckRunOutput = (
  options: FormatWaitingCheckRunOptions
): { title: string; summary: string } => {
  const { evaluation, jobsByRunId } = options;
  const {
    ciRelevantRuns,
    pendingCiRuns,
    stuckRuns,
    skippedRuns,
    blacklistedRuns,
  } = evaluation;

  const completedCount = ciRelevantRuns.length - pendingCiRuns.length;
  const totalCount = ciRelevantRuns.length;
  const { totalJobs, completedJobs } = countJobProgress(jobsByRunId);
  const title = buildTitle(
    totalCount,
    totalJobs,
    completedJobs,
    completedCount
  );

  // If no CI-relevant workflows, show diagnostic info about filtered workflows
  if (totalCount === 0) {
    return {
      title,
      summary: buildNoWorkflowsSummary(blacklistedRuns, skippedRuns),
    };
  }

  const nowMs = Date.now();
  const lines: string[] = [];

  // Build content section (job tables or workflow table)
  if (jobsByRunId && jobsByRunId.size > 0) {
    lines.push(
      ...buildJobTablesSection(
        pendingCiRuns,
        ciRelevantRuns,
        jobsByRunId,
        completedCount,
        nowMs
      )
    );
  } else {
    const { lines: tableLines, truncatedCount } = buildWorkflowTableLines(
      ciRelevantRuns,
      stuckRuns,
      nowMs
    );
    lines.push(...tableLines);
    if (truncatedCount > 0) {
      lines.push("", `_+${truncatedCount} more workflows not shown_`);
    }
  }

  // Add footer stats
  lines.push(
    ...buildFooterStats(
      totalJobs,
      totalCount,
      stuckRuns,
      skippedRuns,
      blacklistedRuns
    )
  );

  // Ensure summary doesn't exceed GitHub's output limit (65535 chars)
  let summary = lines.join("\n");
  if (summary.length > OUTPUT_LIMITS.SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, OUTPUT_LIMITS.SUMMARY_MAX_CHARS - 100)}\n\n_Summary truncated_`;
  }

  return { title, summary };
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
  // Single-pass counting instead of multiple filter passes
  const failedRuns: WorkflowRunResult[] = [];
  let passedCount = 0;
  for (const r of runs) {
    if (r.conclusion === "failure") {
      failedRuns.push(r);
    } else if (r.conclusion === "success") {
      passedCount++;
    }
  }

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

// ============================================================================
// Heal Lifecycle Comments
// ============================================================================
// These comments are used during the heal lifecycle:
// 1. Errors found → "Found X issues in Y jobs"
// 2. Heal triggered → "Healing X issues..."
// 3. Heal success → "Healed X issues. Ready to apply."
// 4. Heal failed → "Failed to heal: {reason}"

// Options for formatting an "errors found" comment
export interface FormatErrorsFoundCommentOptions {
  errorCount: number;
  jobCount: number;
  projectUrl: string;
}

// Format comment when CI fails and fixable errors are detected
export const formatErrorsFoundComment = (
  options: FormatErrorsFoundCommentOptions
): string => {
  const { errorCount, jobCount, projectUrl } = options;
  const errorText = errorCount === 1 ? "1 issue" : `${errorCount} issues`;
  const jobText = jobCount === 1 ? "1 job" : `${jobCount} jobs`;

  const lines: string[] = [];
  lines.push(formatHeader(`Found ${errorText} in ${jobText}.`));
  lines.push("");
  lines.push(
    `[View in dashboard](${projectUrl}) or reply \`@detentsh\` to fix.`
  );

  return lines.join("\n");
};

// Options for formatting a "heal success" comment
export interface FormatHealSuccessCommentOptions {
  filesFixed: number;
  projectUrl: string;
}

// Format comment when heal completes successfully
export const formatHealSuccessComment = (
  options: FormatHealSuccessCommentOptions
): string => {
  const { filesFixed, projectUrl } = options;
  const fileText = filesFixed === 1 ? "1 file" : `${filesFixed} files`;

  const lines: string[] = [];
  lines.push(formatHeader(`Healed ${fileText}. Ready to apply.`));
  lines.push("");
  lines.push(`[Review and apply in dashboard](${projectUrl})`);

  return lines.join("\n");
};

// Options for formatting a "heal failed" comment
export interface FormatHealFailedCommentOptions {
  reason: string;
}

// Format comment when heal fails
export const formatHealFailedComment = (
  options: FormatHealFailedCommentOptions
): string => {
  const { reason } = options;
  // Truncate and sanitize reason to prevent injection
  const safeReason =
    reason.length > 200
      ? `${escapeHtml(reason.slice(0, 197))}...`
      : escapeHtml(reason);

  const lines: string[] = [];
  lines.push(formatHeader("Failed to heal."));
  lines.push("");
  lines.push(`Reason: ${safeReason}`);

  return lines.join("\n");
};

// Format comment when there are no heal candidates
export const formatNoHealCandidatesComment = (): string => {
  return "Nothing to heal";
};
