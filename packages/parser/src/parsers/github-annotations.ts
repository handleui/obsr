/**
 * GitHub Actions annotation parser.
 *
 * Parses workflow commands in the format:
 * - ::error file=<path>,line=<num>,col=<num>,title=<title>::<message>
 * - ::warning file=<path>,line=<num>::<message>
 * - ::notice file=<path>,line=<num>::<message>
 *
 * These are produced by test frameworks (Vitest, Jest), linters, and other tools
 * that support GitHub Actions reporter output.
 *
 * Reference: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */

import {
  applyWorkflowContext,
  BaseParser,
  type ParseContext,
  type ParseResult,
} from "../parser-types.js";
import type { ErrorSeverity, MutableExtractedError } from "../types.js";
import { stripAnsi } from "../utils.js";

// ============================================================================
// Constants
// ============================================================================

const PARSER_ID = "github-annotations";
const PARSER_PRIORITY = 95; // High priority - should parse before generic

/**
 * Maximum line length to process.
 * Lines longer than this are likely malformed or data dumps.
 */
const MAX_LINE_LENGTH = 4096;

// ============================================================================
// Patterns
// ============================================================================

/**
 * Pattern to match GitHub Actions annotation commands.
 *
 * Matches:
 * - ::error file=path,line=num::message
 * - ::error file=path,line=num,col=num::message
 * - ::error file=path,line=num,col=num,title=text::message
 * - ::warning file=...::message
 * - ::notice file=...::message
 *
 * Groups:
 *   1: Command type (error, warning, notice)
 *   2: Parameters string (file=...,line=...,etc)
 *   3: Message content
 *
 * SECURITY: Uses non-greedy quantifiers and bounded character classes
 * to prevent ReDoS attacks.
 */
const annotationPattern = /^::(error|warning|notice)\s*(file=[^:]+)::(.+)$/i;

/**
 * Pattern to extract individual parameters from the parameters string.
 * Parameters are comma-separated key=value pairs.
 *
 * Note: Values can contain spaces and special characters, but not commas
 * (per GitHub Actions spec).
 */
const paramPattern = /(\w+)=([^,]+)/g;

/**
 * Pattern to match TypeScript error codes (e.g., TS2339, ts1234).
 * Used for category inference.
 */
const tsErrorPattern = /^ts\d+:/i;

/**
 * Parse an integer from a string, returning undefined if the result is NaN.
 * This prevents downstream code from receiving NaN instead of undefined.
 */
const safeParseInt = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

// ============================================================================
// Parser Class
// ============================================================================

/**
 * GitHubAnnotationParser extracts errors from GitHub Actions workflow commands.
 *
 * This handles the native annotation format used by:
 * - Vitest (with --reporter=github-actions)
 * - Jest (with jest-github-actions-reporter)
 * - ESLint (with eslint-formatter-gha)
 * - TypeScript (with ts-node's built-in formatter)
 * - Other CI-aware tools
 */
class GitHubAnnotationParser extends BaseParser {
  readonly id = PARSER_ID;
  readonly priority = PARSER_PRIORITY;

  /**
   * Check if this line can be parsed as a GitHub annotation.
   * Only matches lines with file= parameter (actual error location).
   */
  canParse = (line: string, _ctx: ParseContext): number => {
    // SECURITY: Skip overly long lines
    if (line.length > MAX_LINE_LENGTH) {
      return 0;
    }

    const stripped = stripAnsi(line);

    // Fast path: must start with :: and contain file=
    if (!(stripped.startsWith("::") && stripped.includes("file="))) {
      return 0;
    }

    // Verify it matches the full pattern
    if (annotationPattern.test(stripped)) {
      return 0.98; // Very high confidence for exact format match
    }

    return 0;
  };

  /**
   * Parse a GitHub Actions annotation command.
   */
  parse = (line: string, ctx: ParseContext): ParseResult => {
    // SECURITY: Skip overly long lines
    if (line.length > MAX_LINE_LENGTH) {
      return null;
    }

    const stripped = stripAnsi(line);
    const match = annotationPattern.exec(stripped);
    if (!match) {
      return null;
    }

    const [, commandType, paramsStr, message] = match;
    if (!(commandType && paramsStr && message)) {
      return null;
    }

    // Parse parameters
    const params = this.parseParams(paramsStr);

    // Must have at least a file path
    if (!params.file) {
      return null;
    }

    // Map command type to severity
    const severity = this.mapSeverity(commandType);

    const err: MutableExtractedError = {
      message: message.trim(),
      filePath: params.file,
      line: params.line,
      column: params.col,
      severity,
      raw: line,
      category: this.inferCategory(params.file, message),
      source: "github-annotations",
      lineKnown: params.line !== undefined && params.line > 0,
      columnKnown: params.col !== undefined && params.col > 0,
    };

    // Add title as ruleId if present
    if (params.title) {
      err.ruleId = params.title;
    }

    applyWorkflowContext(err, ctx);
    return err;
  };

  /**
   * Parse the parameters string into a structured object.
   */
  private parseParams(paramsStr: string): {
    file?: string;
    line?: number;
    col?: number;
    title?: string;
    endLine?: number;
    endColumn?: number;
  } {
    const params: {
      file?: string;
      line?: number;
      col?: number;
      title?: string;
      endLine?: number;
      endColumn?: number;
    } = {};

    // Reset regex lastIndex for global regex
    paramPattern.lastIndex = 0;

    let match = paramPattern.exec(paramsStr);
    while (match !== null) {
      const [, key, value] = match;
      if (key && value) {
        const trimmedValue = value.trim();

        switch (key.toLowerCase()) {
          case "file":
            params.file = trimmedValue;
            break;
          case "line":
            params.line = safeParseInt(trimmedValue);
            break;
          case "col":
          case "column":
            params.col = safeParseInt(trimmedValue);
            break;
          case "title":
            params.title = trimmedValue;
            break;
          case "endline":
            params.endLine = safeParseInt(trimmedValue);
            break;
          case "endcolumn":
            params.endColumn = safeParseInt(trimmedValue);
            break;
          default:
            // Unknown parameter, skip it
            break;
        }
      }
      match = paramPattern.exec(paramsStr);
    }

    return params;
  }

  /**
   * Map command type to error severity.
   */
  private mapSeverity(commandType: string): ErrorSeverity {
    switch (commandType.toLowerCase()) {
      case "error":
        return "error";
      case "warning":
      case "notice":
        return "warning";
      default:
        return "error";
    }
  }

  /**
   * Infer error category from file path and message.
   */
  private inferCategory(
    file: string,
    message: string
  ): MutableExtractedError["category"] {
    const lowerFile = file.toLowerCase();
    const lowerMessage = message.toLowerCase();

    // Test files
    if (
      lowerFile.includes(".test.") ||
      lowerFile.includes(".spec.") ||
      lowerFile.includes("_test.") ||
      lowerFile.includes("_spec.")
    ) {
      return "test";
    }

    // TypeScript errors (TS2339, ts1234, etc.)
    // tsErrorPattern is case-insensitive and anchored at start, so no need for additional check
    if (tsErrorPattern.test(message)) {
      return "type-check";
    }

    // Lint patterns
    if (
      lowerMessage.includes("lint") ||
      lowerMessage.includes("eslint") ||
      lowerMessage.includes("biome")
    ) {
      return "lint";
    }

    // Assertion patterns (test failures)
    if (
      lowerMessage.includes("assertionerror") ||
      lowerMessage.includes("expected") ||
      lowerMessage.includes("to be") ||
      lowerMessage.includes("to equal")
    ) {
      return "test";
    }

    return "unknown";
  }

  /**
   * Check if a line is noise.
   * This parser handles structured annotations, which are never noise.
   */
  isNoise = (_line: string): boolean => {
    return false;
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new GitHubAnnotationParser instance.
 */
export const createGitHubAnnotationParser = (): GitHubAnnotationParser =>
  new GitHubAnnotationParser();
