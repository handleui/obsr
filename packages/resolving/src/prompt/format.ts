import type { CIError, ErrorCategory } from "@detent/types";
import { INTERNAL_FRAME_PATTERNS, MAX_STACK_TRACE_LINES } from "./system.js";

const DEFAULT_CATEGORY = "unknown";
const DEFAULT_COLUMN = 1;
const MISSING_VALUE = "-";
const DEFAULT_PRIORITY = 999;
const MAX_STACK_TRACE_BYTES = 50 * 1024;

const CATEGORY_PRIORITY: Record<ErrorCategory, number> = {
  compile: 1,
  "type-check": 2,
  test: 3,
  runtime: 4,
  lint: 5,
  infrastructure: 6,
  metadata: 7,
  security: 8,
  dependency: 9,
  config: 10,
  docs: 11,
  unknown: 12,
};

const CATEGORIES_NEEDING_STACK_TRACE = new Set<ErrorCategory>([
  "compile",
  "test",
  "runtime",
  "unknown",
]);

export const getCategoryPriority = (category: ErrorCategory): number =>
  CATEGORY_PRIORITY[category] ?? DEFAULT_PRIORITY;

const escapePromptString = (s: string): string => {
  let result = s.replaceAll("`", "'").replaceAll("\r", "");
  while (result.includes("\n\n\n")) {
    result = result.replaceAll("\n\n\n", "\n\n");
  }
  return result;
};

const isInternalFrame = (line: string): boolean =>
  INTERNAL_FRAME_PATTERNS.some((pattern) => line.includes(pattern));

const filterStackTraceLines = (lines: string[]): string[] =>
  lines.filter((line) => !isInternalFrame(line) && line.trim() !== "");

export const formatStackTrace = (error: CIError): string => {
  if (!error.stackTrace) {
    return "";
  }

  if (error.stackTrace.length > MAX_STACK_TRACE_BYTES) {
    return "  Stack trace: (truncated - exceeds 50KB limit)";
  }

  const category = error.category ?? DEFAULT_CATEGORY;
  if (!CATEGORIES_NEEDING_STACK_TRACE.has(category)) {
    return "";
  }

  const lines = error.stackTrace.trim().split("\n");
  const filtered = filterStackTraceLines(lines);

  if (filtered.length === 0) {
    return "";
  }

  const originalLen = filtered.length;
  const truncated = filtered.length > MAX_STACK_TRACE_LINES;
  const displayLines = truncated
    ? filtered.slice(0, MAX_STACK_TRACE_LINES)
    : filtered;

  const parts = ["  Stack trace:"];
  for (const line of displayLines) {
    parts.push(`    ${escapePromptString(line)}`);
  }

  if (truncated) {
    const remaining = originalLen - MAX_STACK_TRACE_LINES;
    parts.push(`    ... (truncated, ${remaining} more frames)`);
  }

  return parts.join("\n");
};

export const formatError = (error: CIError): string => {
  const parts: string[] = [];

  const category = error.category ?? DEFAULT_CATEGORY;
  const file = error.filePath ? escapePromptString(error.filePath) : "";
  const message = escapePromptString(error.message);

  const lineValue = error.line ?? 0;
  const columnValue =
    error.column ?? (lineValue > 0 ? DEFAULT_COLUMN : undefined);
  const lineLabel = lineValue > 0 ? String(lineValue) : MISSING_VALUE;
  const columnLabel =
    columnValue && columnValue > 0 ? String(columnValue) : MISSING_VALUE;

  const location =
    file !== ""
      ? `${file}:${lineLabel}:${columnLabel}`
      : `line ${lineLabel}:${columnLabel}`;
  parts.push(`[${category}] ${location}: ${message}`);

  if (error.ruleId || error.source) {
    const ruleId = error.ruleId
      ? escapePromptString(error.ruleId)
      : MISSING_VALUE;
    const source = error.source
      ? escapePromptString(error.source)
      : MISSING_VALUE;
    parts.push(`  Rule: ${ruleId} | Source: ${source}`);
  }

  const stackTrace = formatStackTrace(error);
  if (stackTrace) {
    parts.push(stackTrace);
  }

  return parts.join("\n");
};

export const prioritizeErrors = (errors: CIError[]): CIError[] => {
  if (errors.length === 0) {
    return errors;
  }

  const sorted = [...errors];
  sorted.sort((a, b) => {
    const priA = getCategoryPriority(a.category ?? DEFAULT_CATEGORY);
    const priB = getCategoryPriority(b.category ?? DEFAULT_CATEGORY);

    if (priA !== priB) {
      return priA - priB;
    }

    const fileA = a.filePath ?? "";
    const fileB = b.filePath ?? "";
    if (fileA !== fileB) {
      return fileA.localeCompare(fileB);
    }

    const lineA = a.line ?? 0;
    const lineB = b.line ?? 0;
    return lineA - lineB;
  });

  return sorted;
};

export const formatErrors = (errors: CIError[]): string => {
  if (errors.length === 0) {
    return "(no errors)";
  }

  const sorted = prioritizeErrors(errors);
  const parts: string[] = [];

  for (const error of sorted) {
    parts.push(formatError(error));
  }

  if (parts.length === 0) {
    return "(no valid errors)";
  }

  return parts.join("\n\n");
};

export const countErrors = (
  errors: CIError[]
): { errorCount: number; warningCount: number } => {
  let errorCount = 0;
  let warningCount = 0;

  for (const error of errors) {
    if (error.severity === "error") {
      errorCount++;
    } else if (error.severity === "warning") {
      warningCount++;
    }
  }

  return { errorCount, warningCount };
};

export const countByCategory = (
  errors: CIError[]
): Record<ErrorCategory, number> => {
  const counts: Record<ErrorCategory, number> = {
    compile: 0,
    "type-check": 0,
    test: 0,
    runtime: 0,
    lint: 0,
    infrastructure: 0,
    metadata: 0,
    security: 0,
    dependency: 0,
    config: 0,
    docs: 0,
    unknown: 0,
  };

  for (const error of errors) {
    const category = error.category || "unknown";
    counts[category]++;
  }

  return counts;
};

export const formatErrorsWithHints = async (
  errors: CIError[]
): Promise<string> => {
  if (errors.length === 0) {
    return "(no errors)";
  }

  const { matchHints } = await import("@detent/lore");
  const sorted = prioritizeErrors(errors);
  const matches = matchHints(sorted);
  const parts: string[] = [];

  for (const { error, hints: loreHints } of matches) {
    let formatted = formatError(error);
    const allHints = [...(error.hints ?? []), ...loreHints];
    if (allHints.length > 0) {
      formatted += `\n  HINTS: ${allHints.join(" | ")}`;
    }
    parts.push(formatted);
  }

  return parts.join("\n\n");
};
