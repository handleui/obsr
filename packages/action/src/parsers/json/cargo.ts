/**
 * Parser for Cargo/Rust NDJSON output format.
 * Parses output from `cargo build --message-format=json`
 *
 * Each line is a JSON object with a "reason" field:
 * - "compiler-message": Contains rustc diagnostic messages
 * - "compiler-artifact": Build artifacts (ignored)
 * - "build-script-executed": Build script output (ignored)
 * - "build-finished": Build completion (ignored)
 *
 * Compiler message structure:
 * {
 *   "reason": "compiler-message",
 *   "message": {
 *     "message": "unused variable: `x`",
 *     "level": "warning" | "error" | "note" | "help",
 *     "code": { "code": "unused_variables", "explanation": null },
 *     "spans": [{
 *       "file_name": "src/main.rs",
 *       "line_start": 4,
 *       "line_end": 4,
 *       "column_start": 9,
 *       "column_end": 10,
 *       "is_primary": true
 *     }],
 *     "children": [{ "level": "help", "message": "..." }],
 *     "rendered": "warning: unused variable..."
 *   }
 * }
 */

import type { ParsedError } from "../types";

interface CargoSpan {
  file_name: string;
  byte_start?: number;
  byte_end?: number;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  is_primary: boolean;
  text?: Array<{
    text: string;
    highlight_start: number;
    highlight_end: number;
  }>;
  label?: string | null;
  suggested_replacement?: string | null;
  suggestion_applicability?: string | null;
  expansion?: unknown;
}

interface CargoCode {
  code: string;
  explanation?: string | null;
}

interface CargoDiagnostic {
  message: string;
  level: string;
  code?: CargoCode | null;
  spans: CargoSpan[];
  children: CargoDiagnostic[];
  rendered?: string | null;
}

interface CargoCompilerMessage {
  reason: "compiler-message";
  package_id?: string;
  manifest_path?: string;
  target?: {
    kind: string[];
    name: string;
    src_path: string;
  };
  message: CargoDiagnostic;
}

type CargoMessage = CargoCompilerMessage | { reason: string };

/**
 * Find the primary span in a diagnostic's spans array.
 */
const findPrimarySpan = (spans: CargoSpan[]): CargoSpan | undefined =>
  spans.find((span) => span.is_primary);

/**
 * Extract help suggestions from children diagnostics.
 */
const extractSuggestions = (children: CargoDiagnostic[]): string[] => {
  const suggestions: string[] = [];

  for (const child of children) {
    if (child.level === "help" && child.message) {
      // Check if there's a suggested replacement in spans
      const spanWithReplacement = child.spans.find(
        (s) =>
          s.suggested_replacement !== null &&
          s.suggested_replacement !== undefined
      );
      if (spanWithReplacement?.suggested_replacement) {
        suggestions.push(
          `${child.message}: \`${spanWithReplacement.suggested_replacement}\``
        );
      } else {
        suggestions.push(child.message);
      }
    } else if (child.level === "note" && child.message) {
      suggestions.push(`note: ${child.message}`);
    }
  }

  return suggestions;
};

/**
 * Determine if an error has a machine-applicable fix.
 * MachineApplicable = safe to auto-apply
 * MaybeIncorrect = might need human review but still valid
 */
const hasMachineApplicableFix = (
  spans: CargoSpan[],
  children: CargoDiagnostic[]
): boolean => {
  // Check top-level spans
  for (const span of spans) {
    if (
      span.suggestion_applicability === "MachineApplicable" ||
      span.suggestion_applicability === "MaybeIncorrect"
    ) {
      return true;
    }
  }
  // Check children spans
  for (const child of children) {
    for (const span of child.spans) {
      if (
        span.suggestion_applicability === "MachineApplicable" ||
        span.suggestion_applicability === "MaybeIncorrect"
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Try to parse a JSON line, returning null on failure.
 */
const tryParseJson = (line: string): CargoMessage | null => {
  const trimmed = line.trim();
  if (!trimmed?.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CargoMessage;
  } catch {
    return null;
  }
};

/**
 * Convert a diagnostic to a ParsedError.
 */
const diagnosticToError = (diagnostic: CargoDiagnostic): ParsedError => {
  const primarySpan = findPrimarySpan(diagnostic.spans);
  const suggestions = extractSuggestions(diagnostic.children);
  const fixable = hasMachineApplicableFix(
    diagnostic.spans,
    diagnostic.children
  );

  // Include span label in message if available for additional context
  let message = diagnostic.message;
  if (primarySpan?.label) {
    message = `${message}: ${primarySpan.label}`;
  }

  return {
    message,
    filePath: primarySpan?.file_name,
    line: primarySpan?.line_start,
    column: primarySpan?.column_start,
    severity: diagnostic.level === "warning" ? "warning" : "error",
    ruleId: diagnostic.code?.code,
    stackTrace: diagnostic.rendered ?? undefined,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    fixable,
  };
};

/**
 * Check if a parsed message is a compiler message.
 */
const isCompilerMessage = (msg: CargoMessage): msg is CargoCompilerMessage =>
  msg.reason === "compiler-message" && "message" in msg;

/**
 * Parse a single NDJSON line into a ParsedError if it's a compiler message.
 */
const parseCargoLine = (line: string): ParsedError | null => {
  const parsed = tryParseJson(line);

  if (!(parsed && isCompilerMessage(parsed))) {
    return null;
  }

  const diagnostic = parsed.message;

  // Only process errors and warnings at the top level
  if (diagnostic.level !== "error" && diagnostic.level !== "warning") {
    return null;
  }

  return diagnosticToError(diagnostic);
};

/**
 * Parse Cargo NDJSON output into ParsedError array.
 *
 * @param content - Raw NDJSON string from cargo --message-format=json
 * @returns Array of parsed errors
 */
export const parseCargo = (content: string): ParsedError[] => {
  const errors: ParsedError[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const error = parseCargoLine(line);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
};
