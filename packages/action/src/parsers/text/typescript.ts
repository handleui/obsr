/**
 * TypeScript compiler (tsc) text output parser.
 *
 * TypeScript has NO JSON reporter, so we parse text output.
 *
 * Supported formats:
 * - Parenthesized: file.ts(42,5): error TS2304: message
 * - Colon-separated (pretty mode): file.ts:42:5 - error TS2304: message
 */

import type { ParsedError } from "../types";

/**
 * TypeScript file extension pattern.
 * Matches: .ts, .tsx, .mts, .cts, .d.ts, .d.tsx, .d.mts, .d.cts
 */
const TS_EXT_PATTERN = "(?:d\\.)?[cm]?tsx?";

/**
 * Parenthesized format: file.ts(line,col): error TSxxxx: message
 * Or without error code: file.ts(line,col): error: message
 *
 * Groups:
 *   1: file path
 *   2: line number
 *   3: column number
 *   4: severity (error, warning, or fatal error)
 *   5: TS error code (optional)
 *   6: error message
 */
const tsParenPattern = new RegExp(
  `^([^\\s(]+\\.${TS_EXT_PATTERN})\\((\\d+),(\\d+)\\):\\s*(?:(error|warning|fatal error)\\s+)?(TS\\d+)?:?\\s*(.+)$`,
  "i"
);

/**
 * Colon-separated format: file.ts:line:col - error TSxxxx: message
 *
 * Groups:
 *   1: file path
 *   2: line number
 *   3: column number
 *   4: severity (error, warning, or fatal error)
 *   5: TS error code (optional)
 *   6: error message
 */
const tsColonPattern = new RegExp(
  `^([^\\s:]+\\.${TS_EXT_PATTERN}):(\\d+):(\\d+)\\s+-\\s+(error|warning|fatal error)\\s+(?:(TS\\d+):\\s*)?(.+)$`,
  "i"
);

/**
 * Strip ANSI escape codes from a string.
 */
const stripAnsi = (str: string): string =>
  str.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes intentionally use control characters
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );

/**
 * Map severity string to ParsedError severity.
 */
const mapSeverity = (severity: string | undefined): "error" | "warning" =>
  severity?.toLowerCase() === "warning" ? "warning" : "error";

/**
 * Maximum line length to process.
 * Lines longer than this are skipped to prevent ReDoS attacks.
 * TypeScript error lines are typically short; 2000 chars is very generous.
 */
const MAX_LINE_LENGTH = 2000;

/**
 * Parse TypeScript compiler text output and extract errors.
 *
 * @param content - Raw tsc output text
 * @returns Array of parsed errors
 */
export const parseTypeScript = (content: string): ParsedError[] => {
  const errors: ParsedError[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Skip overly long lines to prevent ReDoS on malformed input
    if (line.length > MAX_LINE_LENGTH) {
      continue;
    }

    const stripped = stripAnsi(line.trim());
    if (!stripped) {
      continue;
    }

    // Try parenthesized format first (most common)
    let match = tsParenPattern.exec(stripped);
    if (match) {
      const [, filePath, lineStr, colStr, severity, ruleId, message] = match;
      errors.push({
        filePath,
        line: Number.parseInt(lineStr, 10),
        column: Number.parseInt(colStr, 10),
        severity: mapSeverity(severity),
        ruleId: ruleId || undefined,
        message: message.trim(),
      });
      continue;
    }

    // Try colon-separated format (pretty mode)
    match = tsColonPattern.exec(stripped);
    if (match) {
      const [, filePath, lineStr, colStr, severity, ruleId, message] = match;
      errors.push({
        filePath,
        line: Number.parseInt(lineStr, 10),
        column: Number.parseInt(colStr, 10),
        severity: mapSeverity(severity),
        ruleId: ruleId || undefined,
        message: message.trim(),
      });
    }
  }

  return errors;
};
