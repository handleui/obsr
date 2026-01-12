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
const HTML_ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
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

// Format the main PR comment with error summary (minimal format)
// Returns null if there are no failed workflows (caller should not post comment)
export const formatResultsComment = (
  options: FormatCommentOptions
): string | null => {
  const { owner, repo, headSha, runs } = options;

  // Separate runs by conclusion
  const failedRuns = runs.filter((r) => r.conclusion === "failure");
  const passedCount = runs.filter((r) => r.conclusion === "success").length;
  const otherCount = runs.filter(
    (r) => r.conclusion !== "failure" && r.conclusion !== "success"
  ).length;

  // No failed workflows = no comment needed
  // Caller should handle this by not posting/updating the comment
  if (failedRuns.length === 0) {
    return null;
  }

  const lines: string[] = [];

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

  // Footer: passed count · skipped count · timestamp · CLI command
  const footerParts: string[] = [];

  if (passedCount > 0) {
    footerParts.push(`${passedCount} passed`);
  }
  if (otherCount > 0) {
    footerParts.push(`${otherCount} skipped`);
  }

  footerParts.push(`Updated ${formatTimestamp(new Date())} UTC`);
  footerParts.push(`\`detent errors --commit ${headSha.slice(0, 7)}\``);

  lines.push(footerParts.join(" · "));

  return lines.join("\n");
};

// Options for formatting a "passing" comment (when all checks pass)
export interface FormatPassingCommentOptions {
  runs: WorkflowRunResult[];
  headSha: string;
}

// Format a "passing" comment to update an existing failure comment when all checks pass.
// This replaces the failure table with a success message while preserving the comment.
export const formatPassingComment = (
  options: FormatPassingCommentOptions
): string => {
  const { runs, headSha } = options;

  const passedCount = runs.filter((r) => r.conclusion === "success").length;
  const otherCount = runs.filter(
    (r) => r.conclusion !== "failure" && r.conclusion !== "success"
  ).length;

  const lines: string[] = [];

  lines.push("✓ All checks passed");
  lines.push("");

  // Footer: passed count · skipped count · timestamp
  const footerParts: string[] = [];

  if (passedCount > 0) {
    footerParts.push(`${passedCount} passed`);
  }
  if (otherCount > 0) {
    footerParts.push(`${otherCount} skipped`);
  }
  footerParts.push(`Updated ${formatTimestamp(new Date())} UTC`);
  footerParts.push(`\`${headSha.slice(0, 7)}\``);

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
const createErrorKey = (error: ParsedError): string => {
  return `${error.filePath ?? "unknown"}:${error.line ?? 0}`;
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
  const newLevel = mapSeverityToAnnotationLevel(error.severity);
  const existingLevel = mapSeverityToAnnotationLevel(existing.severity);
  if (newLevel === "failure" && existingLevel !== "failure") {
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

// Extract simplified rule name from full rule ID path
// "lint/correctness/noUnusedVariables" → "noUnusedVariables"
// "@typescript-eslint/no-unused-vars" → "no-unused-vars"
// "TS2345" → "TS2345"
const simplifyRuleId = (ruleId: string): string => {
  // Handle scoped packages (@org/rule-name)
  if (ruleId.startsWith("@")) {
    const parts = ruleId.split("/");
    return parts.at(-1) ?? ruleId;
  }
  // Handle path-style rules (category/subcategory/ruleName)
  if (ruleId.includes("/")) {
    const parts = ruleId.split("/");
    return parts.at(-1) ?? ruleId;
  }
  return ruleId;
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

// === GROUPING HELPERS ===

interface ErrorsBySource {
  source: string;
  displayName: string;
  errors: ParsedError[];
}

interface ErrorsByFile {
  filePath: string;
  errors: ParsedError[];
}

// Group errors by their source tool (typescript, biome, eslint, etc.)
const groupErrorsBySource = (errors: ParsedError[]): ErrorsBySource[] => {
  const grouped = new Map<string, ParsedError[]>();

  for (const error of errors) {
    const source = error.source ?? "unknown";
    const existing = grouped.get(source) ?? [];
    existing.push(error);
    grouped.set(source, existing);
  }

  // Sort sources alphabetically, but put "unknown" last
  return Array.from(grouped.entries())
    .sort(([a], [b]) => {
      if (a === "unknown") {
        return 1;
      }
      if (b === "unknown") {
        return -1;
      }
      return a.localeCompare(b);
    })
    .map(([source, errs]) => ({
      source,
      displayName: capitalizeSource(source),
      errors: errs.sort((a, b) => {
        // Sort by file, then line
        const fileCompare = (a.filePath ?? "").localeCompare(b.filePath ?? "");
        if (fileCompare !== 0) {
          return fileCompare;
        }
        return (a.line ?? 0) - (b.line ?? 0);
      }),
    }));
};

// Group errors by file path within a source
// Note: Assumes errors are already sorted by file then line (from groupErrorsBySource)
// so we only need to sort file paths, not errors within each file
const groupErrorsByFile = (errors: ParsedError[]): ErrorsByFile[] => {
  const grouped = new Map<string, ParsedError[]>();

  for (const error of errors) {
    const filePath = error.filePath ?? "__no_path__";
    const existing = grouped.get(filePath) ?? [];
    existing.push(error);
    grouped.set(filePath, existing);
  }

  // Sort file paths alphabetically
  // Errors within each file are already sorted by line from groupErrorsBySource
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, errs]) => ({
      filePath,
      errors: errs,
    }));
};

// Format the text section with errors grouped by source and file
const formatTextSection = (errors: ParsedError[]): string[] => {
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

  // Group by source, then by file
  const bySource = groupErrorsBySource(errors);

  for (const sourceGroup of bySource) {
    const errorCount = sourceGroup.errors.length;
    // Escape source name to prevent markdown injection via error.source
    const safeName = escapeTableCell(sourceGroup.displayName);
    lines.push(
      `### ${safeName} (${errorCount} error${errorCount === 1 ? "" : "s"})`
    );
    lines.push("");

    const byFile = groupErrorsByFile(sourceGroup.errors);

    for (const fileGroup of byFile) {
      const fileErrorCount = fileGroup.errors.length;
      // Escape HTML in file path to prevent XSS via malicious file names
      const displayPath = escapeHtml(truncatePath(fileGroup.filePath, 80));

      lines.push("<details>");
      lines.push(
        `<summary>${displayPath} (${fileErrorCount} error${fileErrorCount === 1 ? "" : "s"})</summary>`
      );
      lines.push("");
      lines.push("| Line | Message |");
      lines.push("|------|---------|");

      for (const error of fileGroup.errors) {
        const line = error.line ?? "-";
        const message = truncateMessage(error.message);
        lines.push(`| ${line} | ${message} |`);
      }

      lines.push("");
      lines.push("</details>");
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines;
};

// Generate annotation title: concise, scannable header
// Format: "Source: rule" or "Source: category" - clean and minimal
const generateAnnotationTitle = (error: DeduplicatedError): string => {
  const parts: string[] = [];

  // Source with proper casing (e.g., "TypeScript", "ESLint", "Biome")
  const source = error.source ? capitalizeSource(error.source) : "";

  // Simplified rule ID (extract last segment)
  const rule = error.ruleId ? simplifyRuleId(error.ruleId) : "";

  // Build title based on available data
  if (source && rule) {
    // "Biome: noUnusedVariables"
    parts.push(`${source}: ${rule}`);
  } else if (source && error.category) {
    // "TypeScript: type-check"
    parts.push(`${source}: ${error.category}`);
  } else if (source) {
    // "Biome"
    parts.push(source);
  } else if (rule) {
    // "noUnusedVariables"
    parts.push(rule);
  } else if (error.category) {
    // "lint"
    parts.push(error.category);
  }

  // If multiple errors at this location, append count
  if (error.originalCount && error.originalCount > 1) {
    parts.push(`(${error.originalCount} issues)`);
  }

  // Fallback to "Error" if nothing else
  const title = parts.length > 0 ? parts.join(" ") : "Error";

  // Truncate to GitHub's 255 char limit
  return title.length > ANNOTATION_LIMITS.TITLE_MAX_CHARS
    ? `${title.slice(0, ANNOTATION_LIMITS.TITLE_MAX_CHARS - 3)}...`
    : title;
};

// Generate raw_details content: additional context for the annotation
// Includes: stack trace, hint, multiple messages, workflow context
const generateRawDetails = (error: DeduplicatedError): string | undefined => {
  const sections: string[] = [];

  // Multiple messages at same location
  if (error.combinedMessages && error.combinedMessages.length > 1) {
    sections.push("=== All issues at this location ===");
    for (const [i, msg] of error.combinedMessages.entries()) {
      sections.push(`${i + 1}. ${msg}`);
    }
  }

  // Hint/suggestion
  if (error.hint) {
    sections.push("");
    sections.push("=== Suggestion ===");
    sections.push(error.hint);
  }

  // Stack trace (truncated to first 5 lines for readability)
  if (error.stackTrace) {
    sections.push("");
    sections.push("=== Stack Trace ===");
    const stackLines = error.stackTrace.split("\n");
    const maxLines = 5;
    if (stackLines.length > maxLines) {
      sections.push(
        `${stackLines.slice(0, maxLines).join("\n")}\n...[${stackLines.length - maxLines} more lines]`
      );
    } else {
      sections.push(error.stackTrace);
    }
  }

  // Workflow context
  if (error.workflowJob || error.workflowStep) {
    sections.push("");
    sections.push("=== Workflow Context ===");
    if (error.workflowJob) {
      sections.push(`Job: ${error.workflowJob}`);
    }
    if (error.workflowStep) {
      sections.push(`Step: ${error.workflowStep}`);
    }
    if (error.workflowAction) {
      sections.push(`Action: ${error.workflowAction}`);
    }
  }

  // Return undefined if no additional details
  if (sections.length === 0) {
    return undefined;
  }

  // Enforce GitHub API limit (64 KB)
  const result = sections.join("\n");
  return result.length > ANNOTATION_LIMITS.RAW_DETAILS_MAX_BYTES
    ? `${result.slice(0, ANNOTATION_LIMITS.RAW_DETAILS_MAX_BYTES - 20)}...[truncated]`
    : result;
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

  // Add raw_details for complex errors (stack traces, multiple messages, hints)
  const rawDetails = generateRawDetails(error);
  if (rawDetails) {
    annotation.raw_details = rawDetails;
  }

  return annotation;
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
  // Cap at 200 errors for reasonable output size
  const maxDisplayErrors = 200;
  const displayErrors = errors.slice(0, maxDisplayErrors);
  const textLines = formatTextSection(displayErrors);

  // Show truncation note if errors were capped
  if (errors.length > maxDisplayErrors) {
    textLines.push("");
    textLines.push(`_Showing ${maxDisplayErrors} of ${errors.length} errors_`);
  }

  // Footer with CLI command
  textLines.push(
    `\`detent errors --commit ${headSha.slice(0, 7)}\` for full list`
  );

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
