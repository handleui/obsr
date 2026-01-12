/**
 * Biome linter/formatter parser.
 * Handles Biome's GitHub Actions reporter format (--reporter=github).
 *
 * Format: ::error title=lint/rule,file=path,line=N,col=N::message
 *
 * Airtight detection via Biome-specific title prefixes:
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
 * Biome-specific title prefixes for airtight detection.
 * Other tools using GitHub Actions format won't have these prefixes.
 */
const BIOME_TITLE_PREFIXES = [
  "lint/", // All lint rules: lint/suspicious/, lint/style/, etc.
  "format", // Formatting issues
  "organizeImports", // Import organization
] as const;

// ============================================================================
// Patterns
// ============================================================================

/**
 * Main pattern for GitHub Actions workflow command with parameters.
 *
 * Format: ::(error|warning) key=value,key=value::message
 *
 * Security: Bounded repetition, no nested quantifiers.
 */
const WORKFLOW_CMD_PATTERN = /^::(error|warning)\s+(.+?)::(.+)$/;

/**
 * Pattern to extract individual key=value pairs.
 * Handles values with special chars (paths, rule IDs).
 *
 * Security: Non-global version to avoid lastIndex issues in loops.
 */
const PARAM_PATTERN_GLOBAL = /(\w+)=([^,]+?)(?=,\w+=|$)/g;

// ============================================================================
// Helper Functions
// ============================================================================

/** Fast prefix check for ::error or ::warning with space */
const isWorkflowCommand = (line: string): boolean =>
  line.startsWith("::error ") || line.startsWith("::warning ");

/** Check if line contains Biome-specific title */
const hasBiomeTitle = (line: string): boolean => {
  for (const prefix of BIOME_TITLE_PREFIXES) {
    if (line.includes(`title=${prefix}`)) {
      return true;
    }
  }
  return false;
};

/** Parse key=value parameters from param string */
const parseParams = (paramStr: string): Map<string, string> => {
  const params = new Map<string, string>();

  // Create new regex instance to avoid lastIndex issues
  const pattern = new RegExp(PARAM_PATTERN_GLOBAL.source, "g");
  let match = pattern.exec(paramStr);

  while (match !== null) {
    const key = match[1];
    const value = match[2]?.trim();
    if (key && value) {
      params.set(key.toLowerCase(), value);
    }
    match = pattern.exec(paramStr);
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

/** Map Biome title to error category */
const titleToCategory = (title: string): ErrorCategory => {
  if (title.startsWith("lint/")) {
    return "lint";
  }
  if (title === "format") {
    return "lint";
  }
  if (title === "organizeImports") {
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
// Parser Implementation
// ============================================================================

/**
 * BiomeParser handles Biome's GitHub Actions reporter format.
 *
 * Detection is airtight: only matches lines with Biome-specific title prefixes.
 * This prevents bleeding from other tools that use GitHub Actions format.
 */
class BiomeParser extends BaseParser implements NoisePatternProvider {
  readonly id = PARSER_ID;
  readonly priority = PARSER_PRIORITY;

  canParse(line: string, _ctx: ParseContext): number {
    // Length check
    if (line.length > MAX_LINE_LENGTH || line.length < 20) {
      return 0;
    }

    const stripped = stripAnsi(line);

    // Fast path 1: Must be a workflow command
    if (!isWorkflowCommand(stripped)) {
      return 0;
    }

    // Fast path 2: Must have Biome-specific title
    if (!hasBiomeTitle(stripped)) {
      return 0;
    }

    // High confidence - this is definitely Biome output
    return 0.95;
  }

  parse(line: string, ctx: ParseContext): ParseResult {
    if (line.length > MAX_LINE_LENGTH) {
      return null;
    }

    const stripped = stripAnsi(line);

    // Match the workflow command structure
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

    // Parse parameters
    const params = parseParams(paramStr);

    const title = params.get("title");
    const file = params.get("file");
    const lineNum = safeParseInt(params.get("line"));
    const colNum = safeParseInt(params.get("col"));

    // Validate: must have Biome title
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
      category: titleToCategory(title),
      source: "biome",
      raw: line,
      lineKnown: lineNum !== undefined && lineNum > 0,
      columnKnown: colNum !== undefined && colNum > 0,
      messageTruncated: message.length > MAX_MESSAGE_LENGTH,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }

  isNoise(line: string): boolean {
    const stripped = stripAnsi(line).trim().toLowerCase();

    // Empty lines
    if (stripped === "") {
      return true;
    }

    // Biome success/summary messages
    if (stripped.includes("no errors found")) {
      return true;
    }
    if (stripped.includes("checked") && stripped.includes("files")) {
      return true;
    }

    return false;
  }

  noisePatterns(): NoisePatterns {
    return {
      fastPrefixes: [],
      fastContains: ["no errors found"],
      regex: [],
    };
  }
}

/**
 * Create a new BiomeParser instance.
 */
export const createBiomeParser = (): BiomeParser => new BiomeParser();
