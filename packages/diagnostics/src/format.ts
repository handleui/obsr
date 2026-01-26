import type {
  Diagnostic,
  DiagnosticResult,
  DiagnosticSummary,
} from "./types.js";

export interface FormatOptions {
  /** Include suggestions if present (default: false) */
  suggestions?: boolean;
  /** Include stack traces if present (default: false) */
  stackTrace?: boolean;
  /** Show fixable indicator (default: false) */
  fixable?: boolean;
}

const formatLocation = (d: Diagnostic): string | null => {
  if (!d.filePath) {
    return null;
  }
  let loc = d.filePath;
  if (d.line !== undefined) {
    loc += `:${d.line}`;
    if (d.column !== undefined) {
      loc += `:${d.column}`;
    }
  }
  return loc;
};

const formatMessage = (d: Diagnostic, options?: FormatOptions): string => {
  const severity = d.severity ?? "error";
  const rule = d.ruleId ? ` (${d.ruleId})` : "";
  const fixableTag = options?.fixable && d.fixable ? " [fixable]" : "";
  return `${severity}${rule}: ${d.message}${fixableTag}`;
};

const formatSuggestions = (d: Diagnostic): string[] => {
  if (!d.suggestions?.length) {
    return [];
  }
  return d.suggestions.map((s) => `  💡 ${s}`);
};

const formatStackTrace = (d: Diagnostic): string[] => {
  if (!d.stackTrace) {
    return [];
  }
  return ["", ...d.stackTrace.split("\n").map((line) => `    ${line}`)];
};

const formatSummary = (summary: DiagnosticSummary): string => {
  const { total, errors, warnings } = summary;
  const p = total !== 1 ? "s" : "";
  const e = errors !== 1 ? "s" : "";
  const w = warnings !== 1 ? "s" : "";
  return `${total} problem${p} (${errors} error${e}, ${warnings} warning${w})`;
};

/**
 * Format diagnostics as human-readable text.
 *
 * @example
 * ```
 * src/app.ts:10:5 - error TS2304: Cannot find name 'foo'
 * src/utils.ts:25:1 - warning: 'x' is defined but never used
 *
 * 2 problems (1 error, 1 warning)
 * ```
 *
 * @example With options
 * ```ts
 * formatDiagnostics(result, { suggestions: true, stackTrace: true })
 * ```
 */
export const formatDiagnostics = (
  result: DiagnosticResult,
  options?: FormatOptions
): string => {
  if (result.diagnostics.length === 0) {
    return "No diagnostics found.";
  }

  const lines: string[] = [];

  for (const d of result.diagnostics) {
    const loc = formatLocation(d);
    const msg = formatMessage(d, options);
    lines.push(loc ? `${loc} - ${msg}` : msg);

    if (options?.suggestions) {
      lines.push(...formatSuggestions(d));
    }
    if (options?.stackTrace) {
      lines.push(...formatStackTrace(d));
    }
  }

  lines.push("", formatSummary(result.summary));
  return lines.join("\n");
};
