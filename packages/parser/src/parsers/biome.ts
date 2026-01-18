/**
 * Biome linter/formatter parser.
 * Handles both console format and GitHub Actions reporter format.
 *
 * Console format (default):
 *   filepath:line:col rule-id CATEGORY ━━━
 *   × Error message here
 *
 * GitHub Actions format (--reporter=github):
 *   ::error title=lint/rule,file=path,line=N,col=N::message
 *
 * Airtight detection via Biome-specific rule prefixes:
 * - lint/* (lint/suspicious/, lint/style/, etc.)
 * - format
 * - organizeImports
 *
 * Sources:
 * - https://biomejs.dev/reference/reporters/
 * - https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */

import {
  applyWorkflowContext,
  BaseParser,
  type NoisePatternProvider,
  type NoisePatterns,
  type ParseContext,
  type ParseResult,
} from "../parser-types.js";
import type { ErrorCategory, MutableExtractedError } from "../types.js";
import { stripAnsi } from "../utils.js";

// ============================================================================
// Constants
// ============================================================================

const PARSER_ID = "biome";
const PARSER_PRIORITY = 75; // Same as ESLint

/** Maximum line length to process (prevents DoS) */
const MAX_LINE_LENGTH = 4096;

/** Maximum message length to extract */
const MAX_MESSAGE_LENGTH = 1024;

/**
 * Biome-specific rule prefixes for airtight detection.
 * Other tools won't have these prefixes.
 */
const BIOME_RULE_PREFIXES = [
  "lint/", // All lint rules: lint/suspicious/, lint/style/, etc.
  "format", // Formatting issues
  "organizeImports", // Import organization
] as const;

// ============================================================================
// Patterns
// ============================================================================

/**
 * Console format header pattern.
 * Matches: filepath:line:col rule-id [TAGS...] ━━━
 * Example: test-error.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━
 *
 * Biome diagnostic tags (in display order from Biome source):
 * - INTERNAL: diagnostic from internal error
 * - FIXABLE: has a fix suggestion
 * - DEPRECATED: deprecated/obsolete code
 * - VERBOSE: verbose diagnostic (shown with --verbose)
 *
 * Tags appear with space padding and multiple tags may appear in sequence.
 * Example with multiple tags: "lint/foo  DEPRECATED  FIXABLE  ━━━"
 *
 * Groups: [1]=file, [2]=line, [3]=col, [4]=rule-id, [5]=all tags string (may be undefined)
 */
const CONSOLE_HEADER_PATTERN =
  /^([^\s:]+):(\d+):(\d+)\s+(lint\/\S+|format|organizeImports)\s+((?:(?:INTERNAL|FIXABLE|DEPRECATED|VERBOSE)\s+)+)?/;

/**
 * Console format error message pattern.
 * Matches: × message or ✕ message
 * The × (U+00D7) or ✕ (U+2715) character indicates an error.
 */
const CONSOLE_ERROR_PATTERN = /^\s*[×✕]\s+(.+)$/;

/**
 * GitHub Actions workflow command pattern.
 * Format: ::(error|warning) key=value,key=value::message
 */
const WORKFLOW_CMD_PATTERN = /^::(error|warning)\s+(.+?)::(.+)$/;

/**
 * Pattern to extract individual key=value pairs.
 */
const PARAM_PATTERN_GLOBAL = /(\w+)=([^,]+?)(?=,\w+=|$)/g;

// ============================================================================
// Noise Detection Patterns
// ============================================================================

/** Matches line numbers in code context (e.g., "  5 │") */
const LINE_NUMBER_PATTERN = /^\s*\d+\s*│/;

/** Matches box drawing and arrow characters */
const BOX_DRAWING_PATTERN = /^\s*[>│├└┌┐┘┤┴┬┼─━]+\s*$/;

/** Matches caret underlines (e.g., "  ^^^") */
const CARET_PATTERN = /^\s*\^+\s*$/;

/** Matches info lines with ℹ prefix */
const INFO_LINE_PATTERN = /^\s*[ℹi]\s+/;

/** Matches diff line numbers (e.g., "  5  6 │") */
const DIFF_LINE_PATTERN = /^\s*\d+\s+\d+\s*│/;

// ============================================================================
// Helper Functions
// ============================================================================

/** Fast prefix check for ::error or ::warning */
const isWorkflowCommand = (line: string): boolean =>
  line.startsWith("::error ") || line.startsWith("::warning ");

/** Check if line contains Biome-specific rule */
const hasBiomeRule = (line: string): boolean => {
  for (const prefix of BIOME_RULE_PREFIXES) {
    if (line.includes(prefix)) {
      return true;
    }
  }
  return false;
};

/** Check if line contains Biome-specific title (for GitHub Actions format) */
const hasBiomeTitle = (line: string): boolean => {
  for (const prefix of BIOME_RULE_PREFIXES) {
    if (line.includes(`title=${prefix}`)) {
      return true;
    }
  }
  return false;
};

/** Parse key=value parameters from param string */
const parseParams = (paramStr: string): Map<string, string> => {
  const params = new Map<string, string>();
  for (const match of paramStr.matchAll(PARAM_PATTERN_GLOBAL)) {
    const key = match[1];
    const value = match[2]?.trim();
    if (key && value) {
      params.set(key.toLowerCase(), value);
    }
  }
  return params;
};

/** Safely parse integer */
const safeParseInt = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) || num < 0 ? undefined : num;
};

/** Map Biome rule to error category */
const ruleToCategory = (rule: string): ErrorCategory => {
  if (rule.startsWith("lint/")) {
    return "lint";
  }
  if (rule === "format" || rule === "organizeImports") {
    return "lint";
  }
  return "unknown";
};

/** Truncate message to max length */
const truncateMessage = (msg: string): string =>
  msg.length <= MAX_MESSAGE_LENGTH
    ? msg
    : `${msg.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;

/**
 * Parse diagnostic tags from the captured tags string.
 * Tags appear as: "FIXABLE  " or "DEPRECATED  FIXABLE  "
 *
 * @param tagsStr - The raw tags string from regex capture group (may be undefined)
 * @returns Object with boolean flags for each recognized tag
 */
const parseTags = (
  tagsStr: string | undefined
): { fixable: boolean; deprecated: boolean } => {
  if (!tagsStr) {
    return { fixable: false, deprecated: false };
  }
  return {
    fixable: tagsStr.includes("FIXABLE"),
    deprecated: tagsStr.includes("DEPRECATED"),
  };
};

/** Matches error pointer lines (e.g., "      │       ^^^^^^") */
const POINTER_LINE_PATTERN = /^\s*│\s*[\^]+/;

/** Check if a line is a context line (code snippets, box drawing, etc.) */
const isContextLine = (stripped: string): boolean =>
  LINE_NUMBER_PATTERN.test(stripped) ||
  DIFF_LINE_PATTERN.test(stripped) ||
  INFO_LINE_PATTERN.test(stripped) ||
  BOX_DRAWING_PATTERN.test(stripped) ||
  CARET_PATTERN.test(stripped) ||
  POINTER_LINE_PATTERN.test(stripped);

// ============================================================================
// Pending Error State
// ============================================================================

interface PendingError {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  raw: string;
  /** True if FIXABLE tag was present in header */
  fixable: boolean;
}

// ============================================================================
// Context Accumulation State
// ============================================================================

/**
 * State for accumulating context lines after an error is emitted.
 * Context lines are code snippets that follow the error (e.g., "  5 │ const foo = 'bar';")
 */
interface ContextAccumulator {
  /** The error to append context to */
  error: MutableExtractedError;
  /** Accumulated context lines */
  lines: string[];
}

// ============================================================================
// Parser Implementation
// ============================================================================

/**
 * BiomeParser handles Biome's console and GitHub Actions reporter formats.
 *
 * Console format is multi-line:
 * 1. Header line with file:line:col and rule
 * 2. Error message line with × prefix
 * 3. Context lines with code snippets (captured and appended to error's raw field)
 *
 * GitHub Actions format is single-line:
 * ::error title=rule,file=path,line=N,col=N::message
 */
class BiomeParser extends BaseParser implements NoisePatternProvider {
  readonly id = PARSER_ID;
  readonly priority = PARSER_PRIORITY;

  /** Pending console format header waiting for message */
  private pending: PendingError | null = null;

  /** Context accumulator for capturing code context lines after errors */
  private contextAccumulator: ContextAccumulator | null = null;

  canParse(line: string, _ctx: ParseContext): number {
    if (line.length > MAX_LINE_LENGTH || line.length < 10) {
      return 0;
    }

    const stripped = stripAnsi(line);

    // Check for GitHub Actions format
    if (isWorkflowCommand(stripped) && hasBiomeTitle(stripped)) {
      return 0.95;
    }

    // Check for console format header (file:line:col rule)
    if (hasBiomeRule(stripped) && CONSOLE_HEADER_PATTERN.test(stripped)) {
      return 0.95;
    }

    // Check for console format error message (× ...)
    if (this.pending && CONSOLE_ERROR_PATTERN.test(stripped)) {
      return 0.95;
    }

    return 0;
  }

  parse(line: string, ctx: ParseContext): ParseResult {
    if (line.length > MAX_LINE_LENGTH) {
      return null;
    }

    const stripped = stripAnsi(line);

    // Try to capture context lines for previous error before processing new content
    // This allows us to accumulate context without interfering with error detection
    if (this.contextAccumulator && isContextLine(stripped)) {
      this.contextAccumulator.lines.push(line);
      return null; // Line captured as context, don't process further
    }

    // Try GitHub Actions format first
    if (isWorkflowCommand(stripped)) {
      // Flush any accumulated context before processing new error
      this.flushContext();
      return this.parseWorkflowCommand(stripped, line, ctx);
    }

    // Try console format header
    const headerMatch = CONSOLE_HEADER_PATTERN.exec(stripped);
    if (headerMatch) {
      // Flush any accumulated context before processing new header
      this.flushContext();

      const file = headerMatch[1];
      const lineNum = safeParseInt(headerMatch[2]);
      const colNum = safeParseInt(headerMatch[3]);
      const ruleId = headerMatch[4];
      const tags = parseTags(headerMatch[5]);

      if (file && lineNum !== undefined && ruleId) {
        // Store pending error, wait for message line
        this.pending = {
          filePath: file,
          line: lineNum,
          column: colNum ?? 0,
          ruleId,
          raw: line,
          fixable: tags.fixable,
        };
      }
      return null; // Wait for message line
    }

    // Try console format error message
    if (this.pending) {
      const errorMatch = CONSOLE_ERROR_PATTERN.exec(stripped);
      if (errorMatch) {
        const message = errorMatch[1];
        if (message) {
          const err = this.createError(this.pending, message, line, ctx);
          this.pending = null;
          // Start accumulating context for this error
          this.startContextAccumulation(err);
          return err;
        }
      }
    }

    // Non-matching line - flush any accumulated context
    this.flushContext();
    return null;
  }

  private parseWorkflowCommand(
    stripped: string,
    raw: string,
    ctx: ParseContext
  ): ParseResult {
    const match = WORKFLOW_CMD_PATTERN.exec(stripped);
    if (!match) {
      return null;
    }

    const severity = match[1] as "error" | "warning";
    const paramStr = match[2];
    const message = match[3];

    if (!(paramStr && message)) {
      return null;
    }

    const params = parseParams(paramStr);
    const title = params.get("title");
    const file = params.get("file");
    const lineNum = safeParseInt(params.get("line"));
    const colNum = safeParseInt(params.get("col"));

    if (!(title && hasBiomeTitle(`title=${title}`))) {
      return null;
    }

    const err: MutableExtractedError = {
      message: truncateMessage(message.trim()),
      filePath: file || undefined,
      line: lineNum,
      column: colNum,
      ruleId: title,
      severity,
      category: ruleToCategory(title),
      source: "biome",
      raw,
      lineKnown: lineNum !== undefined && lineNum > 0,
      columnKnown: colNum !== undefined && colNum > 0,
      messageTruncated: message.length > MAX_MESSAGE_LENGTH,
    };

    applyWorkflowContext(err, ctx);
    // Start accumulating context for this error
    this.startContextAccumulation(err);
    return err;
  }

  private createError(
    pending: PendingError,
    message: string,
    raw: string,
    ctx: ParseContext
  ): MutableExtractedError {
    const err: MutableExtractedError = {
      message: truncateMessage(message.trim()),
      filePath: pending.filePath,
      line: pending.line,
      column: pending.column,
      ruleId: pending.ruleId,
      severity: "error",
      category: ruleToCategory(pending.ruleId),
      source: "biome",
      raw: `${pending.raw}\n${raw}`,
      lineKnown: true,
      columnKnown: pending.column > 0,
      messageTruncated: message.length > MAX_MESSAGE_LENGTH,
      fixable: pending.fixable,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }

  isNoise(line: string): boolean {
    const stripped = stripAnsi(line).trim().toLowerCase();

    if (stripped === "") {
      return true;
    }

    // Success/summary messages
    if (stripped.includes("no errors found")) {
      return true;
    }
    if (stripped.includes("checked") && stripped.includes("files")) {
      return true;
    }

    // Code context lines (line numbers, arrows, underlines)
    if (LINE_NUMBER_PATTERN.test(stripped)) {
      return true;
    }
    if (BOX_DRAWING_PATTERN.test(stripped)) {
      return true;
    }
    if (CARET_PATTERN.test(stripped)) {
      return true;
    }

    // Info lines (ℹ prefix)
    if (INFO_LINE_PATTERN.test(stripped)) {
      return true;
    }

    // Diff suggestion lines
    if (DIFF_LINE_PATTERN.test(stripped)) {
      return true;
    }

    // Error pointer lines (e.g., "      │       ^^^^^^")
    if (POINTER_LINE_PATTERN.test(stripped)) {
      return true;
    }

    return false;
  }

  noisePatterns(): NoisePatterns {
    return {
      fastPrefixes: [],
      fastContains: ["no errors found", "checked", "files"],
      regex: [LINE_NUMBER_PATTERN, INFO_LINE_PATTERN],
    };
  }

  reset(): void {
    this.pending = null;
    this.flushContext();
    this.contextAccumulator = null;
  }

  /**
   * Flush accumulated context lines to the error's raw field.
   */
  private flushContext(): void {
    if (this.contextAccumulator && this.contextAccumulator.lines.length > 0) {
      const contextStr = this.contextAccumulator.lines.join("\n");
      this.contextAccumulator.error.raw = `${this.contextAccumulator.error.raw}\n${contextStr}`;
      this.contextAccumulator.lines = [];
    }
  }

  /**
   * Start accumulating context for an error.
   */
  private startContextAccumulation(error: MutableExtractedError): void {
    // Flush any previous context first
    this.flushContext();
    this.contextAccumulator = { error, lines: [] };
  }
}

/**
 * Create a new BiomeParser instance.
 */
export const createBiomeParser = (): BiomeParser => new BiomeParser();
