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
 * Matches: filepath:line:col rule-id CATEGORY ━━━
 * Example: test-error.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━
 *
 * Groups: [1]=file, [2]=line, [3]=col, [4]=rule-id
 */
const CONSOLE_HEADER_PATTERN =
  /^([^\s:]+):(\d+):(\d+)\s+(lint\/\S+|format|organizeImports)\s+/;

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

// ============================================================================
// Pending Error State
// ============================================================================

interface PendingError {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  raw: string;
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
 *
 * GitHub Actions format is single-line:
 * ::error title=rule,file=path,line=N,col=N::message
 */
class BiomeParser extends BaseParser implements NoisePatternProvider {
  readonly id = PARSER_ID;
  readonly priority = PARSER_PRIORITY;

  /** Pending console format header waiting for message */
  private pending: PendingError | null = null;

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

    // Try GitHub Actions format first
    if (isWorkflowCommand(stripped)) {
      return this.parseWorkflowCommand(stripped, line, ctx);
    }

    // Try console format header
    const headerMatch = CONSOLE_HEADER_PATTERN.exec(stripped);
    if (headerMatch) {
      const file = headerMatch[1];
      const lineNum = safeParseInt(headerMatch[2]);
      const colNum = safeParseInt(headerMatch[3]);
      const ruleId = headerMatch[4];

      if (file && lineNum !== undefined && ruleId) {
        // Store pending error, wait for message line
        this.pending = {
          file,
          line: lineNum,
          column: colNum ?? 0,
          ruleId,
          raw: line,
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
          return err;
        }
      }
    }

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
      file: file || undefined,
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
      file: pending.file,
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
  }
}

/**
 * Create a new BiomeParser instance.
 */
export const createBiomeParser = (): BiomeParser => new BiomeParser();
