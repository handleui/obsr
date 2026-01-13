/**
 * Vitest test runner error parser.
 *
 * Supported formats:
 * - Failed test markers: x test name, X test name
 * - Test file summaries: > file.test.ts (X tests | Y failed)
 * - Assertion errors with diff output
 * - Stack traces: > /path/to/file.ts:line:col or at /path/to/file.ts:line:col
 * - FAIL markers: FAIL path/to/file.test.ts
 */

import type { NoisePatternProvider, NoisePatterns } from "../parser-types.js";
import {
  applyWorkflowContext,
  MultiLineParser,
  type ParseContext,
  type ParseResult,
} from "../parser-types.js";
import type { MutableExtractedError } from "../types.js";
import { stripAnsi } from "../utils.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_STACK_FRAMES = 100;
const MAX_TRACEBACK_BYTES = 256 * 1024; // 256KB
const MAX_MESSAGE_LENGTH = 2000;
/**
 * SECURITY: Maximum raw lines to accumulate. Prevents memory exhaustion
 * from malicious input with many short lines that stay under byte limits.
 */
const MAX_RAW_LINES = 500;
/**
 * SECURITY: Maximum line length to process. Lines longer than this are likely
 * malformed or minified code, not error output. Prevents ReDoS attacks on
 * regex patterns with unbounded quantifiers.
 */
const MAX_LINE_LENGTH = 4096;

// ============================================================================
// Cache Types
// ============================================================================

/**
 * HACK: Cache detected format between canParse() and parse() to avoid running
 * expensive regex operations twice. Pattern adopted from eslint.ts parser.
 */
type DetectedFormat =
  | "fail-marker"
  | "test-file-summary"
  | "assertion-error"
  | "failed-test-name"
  | "stack-frame";

// ============================================================================
// Patterns
// ============================================================================

/**
 * Test file with failure count: "> src/__tests__/file.test.ts (1 test | 1 failed)"
 * SECURITY: Uses [^)]* instead of .*? to prevent ReDoS - limits backtracking
 * by only matching non-paren characters before the failure count.
 */
const testFileSummaryPattern =
  /^\s*[❯>]\s+(\S+\.(?:test|spec)\.(?:tsx|ts|jsx|js|mts|cts|mjs|cjs))\s+\([^)]*?(\d+)\s+failed/;

/**
 * Failed test name: "x test name" or "X test name" (Unicode or ASCII)
 * SECURITY: Uses {1,500} instead of + to bound the capture group length.
 * Combined with MAX_LINE_LENGTH check, prevents ReDoS on long test names.
 *
 * LIMITATION: ASCII 'x' and 'X' markers may cause false positives for lines
 * that happen to start with x/X followed by spaces (e.g., "X coordinate value"
 * in debug output). The lower confidence score (0.85) helps mitigate this by
 * allowing higher-confidence parsers to take precedence.
 */
const failedTestNamePattern = /^\s*[×✕xX]\s+(.{1,500})$/;

/** FAIL marker: "FAIL src/__tests__/file.test.ts" or " FAIL  file.test.ts" */
const failMarkerPattern =
  /^\s*FAIL\s+(\S+\.(?:test|spec)\.(?:tsx|ts|jsx|js|mts|cts|mjs|cjs))/;

/**
 * Assertion/runtime error start pattern.
 * Matches common JavaScript error types that Vitest may throw.
 * SECURITY: Uses bounded capture group {1,2000} to limit message length.
 */
const assertionErrorPattern =
  /^(AssertionError|Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError):\s+(.{1,2000})$/;

/** Stack frame: "> /path/to/file.ts:20:28" or "at /path/to/file.ts:20:28" */
const stackFramePattern = /^\s*(?:[❯>]|at)\s+(\S+):(\d+):(\d+)/;

/** Stack frame with function: "at functionName (/path/to/file.ts:20:28)" */
const stackFrameWithFuncPattern = /^\s*at\s+\S+\s+\(([^:]+):(\d+):(\d+)\)/;

/**
 * Pattern to detect internal vitest/test runner stack frames that should be filtered.
 * These are not useful for debugging - users care about their test code, not runner internals.
 * Matches paths like:
 * - node_modules/@vitest/runner/dist/index.js
 * - node_modules/vitest/dist/...
 * - node_modules/bun/@vitest+runner@.../...
 */
const vitestInternalFramePattern =
  /node_modules\/(?:\.bun\/)?(?:@?vitest[+/]|vitest\/)/i;

/** Diff expected line: "- Expected  "4"" or "Expected: 4" */
const diffExpectedPattern = /^\s*[-−]\s*Expected\s*/i;

/** Diff received line: "+ Received  "5"" or "Received: 5" */
const diffReceivedPattern = /^\s*\+\s*Received\s*/i;

/**
 * expect() call line for context
 * SECURITY: Uses [^)]+ to match non-paren characters only, preventing
 * catastrophic backtracking on nested parentheses in malicious input.
 */
const expectCallPattern = /^\s*expect\([^)]+\)\.\w+/;

/** Vitest error block separator */
const errorBlockSeparator = /^[⎯─]{3,}/;

/** Test file header in verbose output */
const testFileHeaderPattern =
  /^\s*[❯>✓√✔×✕]\s+\S+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)/;

/** Code context line pattern (indented) */
const codeContextPattern = /^\s{2,}\S/;

/**
 * Pattern to identify lines that likely contain error context.
 * Matches lines with:
 * - Object/array notation: { } [ ]
 * - Assignment/comparison operators: = === !==
 * - Common error keywords: expected, received, actual, undefined, null
 * - Numeric values or quoted strings
 * - Line numbers or column indicators
 */
const errorContextHeuristicPattern =
  /[{}[\]=]|expected|received|actual|undefined|null|true|false|".*"|'.*'|:\s*\d+/i;

// ============================================================================
// Noise Patterns
// ============================================================================

const noisePatterns: readonly RegExp[] = [
  /^\s*$/, // Empty/whitespace lines
  /^\s*[✓√✔]\s+/, // Passing tests
  /^\s*Test Files\s+\d+/i, // Summary: Test Files count
  /^\s*Tests\s+\d+\s+(passed|failed|skipped)/i, // Summary line
  /^\s*Duration\s+[\d.]+/i, // Duration line
  /^\s*Start at\s+/i, // Start time
  /^PASS\s+/i, // Passing test suite
  /^\s*\d+\s+passed/i, // "X passed" summary
  /^\s*\d+\s+skipped/i, // "X skipped" summary
  /^Vitest\s+v?[\d.]+/i, // Vitest version header (with or without 'v')
  /^Running\s+tests/i, // Running tests message
  /^Collecting\s+tests/i, // Collecting tests
  /^Re-running\s+tests/i, // Re-running message
  /^\s*[⎯─]{10,}/, // Long horizontal separator lines
  /^DEV\s+/i, // Dev mode indicator
  /^RUN\s+v?[\d.]+/i, // Run indicator with version
  /^watch mode/i, // Watch mode indicator
  /^\s*Browser\s+/i, // Browser mode output
  /^Coverage\s+/i, // Coverage output
  /^\s*\|\s+File\s+/i, // Coverage table header
  /^\s*\|\s+All files\s+/i, // Coverage summary
  /^Snapshots\s+/i, // Snapshot summary
  /^\s*[›>]\s+\d+\s+snapshot/i, // Snapshot count
  /^\s*stdout\s*\|/i, // Console output prefix
  /^\s*stderr\s*\|/i, // Error output prefix
  /^\s*[⎯↓]\s+/i, // Skipped test indicators
  /^\s*\[[\d:]+\]\s*$/, // Timestamp-only lines
  /^Transforming/i, // Vite transforming
  /^✨\s+/, // Sparkle indicators (success)
  /^⠋|^⠙|^⠹|^⠸|^⠼|^⠴|^⠦|^⠧|^⠇|^⠏/, // Spinner characters
  /^Waiting for file changes/i, // Watch mode waiting message
  /^Press \w+ to/i, // Interactive command hints (e.g., "Press h to show help")
  /^No test files found/i, // No tests message
  /^Typechecking/i, // Type checking indicator
  /^Restarting due to/i, // Restart message
  // TAP format noise patterns: Vitest supports --reporter=tap output.
  // These are included here for noise filtering only (not error parsing).
  // If TAP reporter becomes more commonly used with distinct error formats,
  // consider extracting to a dedicated TAP parser.
  /^ok\s+\d+\s+-/i, // TAP format passing test
  /^\d+\.\.\d+$/i, // TAP format test plan (e.g., "1..5")
  /^TAP version \d+$/i, // TAP version header
  /^# tests \d+$/i, // TAP tests count
  /^# pass \d+$/i, // TAP pass count
  /^# ok$/i, // TAP ok summary
];

const noiseFastPrefixes: readonly string[] = [
  "✓ ",
  "√ ",
  "✔ ",
  "pass ",
  "⎯ ",
  "↓ ",
  "stdout |",
  "stderr |",
  "dev ",
  "vite ",
  "rerun ",
  "duration ",
  "transforming",
  "collecting",
  "running tests",
  "waiting for",
  "press ",
  "no test files",
  "typechecking",
  "restarting",
  "vitest ",
  "tap version",
  "# tests",
  "# pass",
  "# ok",
  "ok ",
];

const noiseFastContains: readonly string[] = [
  " passed",
  " passed in ",
  "tests passed",
  "test passed",
  "all tests passed",
  "duration ",
  "start at ",
  "browser:",
  "test files",
  "watch mode",
  "re-running",
  "file changes",
  "no tests found",
];

// ============================================================================
// Utility Functions
// ============================================================================

const truncateMessage = (msg: string): string => {
  if (msg.length <= MAX_MESSAGE_LENGTH) {
    return msg;
  }
  return msg.slice(0, MAX_MESSAGE_LENGTH);
};

// ============================================================================
// Error State
// ============================================================================

interface VitestErrorState {
  inError: boolean;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  testName: string | undefined;
  message: string;
  errorType: string | undefined;
  stackTrace: string[];
  diffLines: string[];
  byteCount: number;
  frameCount: number;
  raw: string[];
}

const createErrorState = (): VitestErrorState => ({
  inError: false,
  file: undefined,
  line: undefined,
  column: undefined,
  testName: undefined,
  message: "",
  errorType: undefined,
  stackTrace: [],
  diffLines: [],
  byteCount: 0,
  frameCount: 0,
  raw: [],
});

const resetErrorState = (state: VitestErrorState): void => {
  state.inError = false;
  state.file = undefined;
  state.line = undefined;
  state.column = undefined;
  state.testName = undefined;
  state.message = "";
  state.errorType = undefined;
  state.stackTrace = [];
  state.diffLines = [];
  state.byteCount = 0;
  state.frameCount = 0;
  state.raw = [];
};

// ============================================================================
// Vitest Parser
// ============================================================================

/**
 * VitestParser handles Vitest test runner output including failed tests,
 * assertion errors, stack traces, and diff output.
 */
export class VitestParser
  extends MultiLineParser
  implements NoisePatternProvider
{
  readonly id = "vitest";
  readonly priority = 80;

  private readonly errorState: VitestErrorState = createErrorState();

  // HACK: Cache for avoiding double pattern matching between canParse and parse
  private lastStripped = "";
  private lastFormat: DetectedFormat | null = null;
  private lastMatch: RegExpExecArray | null = null;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parser method requires multiple pattern checks with fast-path optimizations for performance
  canParse(line: string, _ctx: ParseContext): number {
    // SECURITY: Skip overly long lines to prevent ReDoS attacks
    if (line.length > MAX_LINE_LENGTH) {
      return 0;
    }

    const stripped = stripAnsi(line);

    // Cache the stripped line for potential reuse in parse()
    this.lastStripped = stripped;
    this.lastFormat = null;
    this.lastMatch = null;

    // Check if we're in a multi-line state (fast path)
    if (this.errorState.inError) {
      return 0.9;
    }

    // Fast path: skip for empty lines
    if (stripped.trim() === "") {
      return 0;
    }

    // FAIL marker (high confidence) - cache match for parse()
    if (stripped.includes("FAIL")) {
      const failMatch = failMarkerPattern.exec(stripped);
      if (failMatch) {
        this.lastFormat = "fail-marker";
        this.lastMatch = failMatch;
        return 0.95;
      }
    }

    // Test file with failure count - cache match for parse()
    if (
      stripped.includes("failed") &&
      (stripped.includes("❯") || stripped.includes(">"))
    ) {
      const summaryMatch = testFileSummaryPattern.exec(stripped);
      if (summaryMatch) {
        this.lastFormat = "test-file-summary";
        this.lastMatch = summaryMatch;
        return 0.93;
      }
    }

    // Assertion error - fast path checks common JS error types before regex
    if (stripped.includes(": ")) {
      const firstChar = stripped[0];
      if (
        (firstChar === "A" ||
          firstChar === "E" ||
          firstChar === "T" ||
          firstChar === "R" ||
          firstChar === "S" ||
          firstChar === "U") &&
        (stripped.startsWith("AssertionError") ||
          stripped.startsWith("Error") ||
          stripped.startsWith("TypeError") ||
          stripped.startsWith("ReferenceError") ||
          stripped.startsWith("SyntaxError") ||
          stripped.startsWith("RangeError") ||
          stripped.startsWith("URIError") ||
          stripped.startsWith("EvalError") ||
          stripped.startsWith("AggregateError"))
      ) {
        const assertionMatch = assertionErrorPattern.exec(stripped);
        if (assertionMatch) {
          this.lastFormat = "assertion-error";
          this.lastMatch = assertionMatch;
          return 0.92;
        }
      }
    }

    // Failed test name marker - fast path: check for x/X markers
    const trimmed = stripped.trimStart();
    const markerChar = trimmed[0];
    if (
      markerChar === "×" ||
      markerChar === "✕" ||
      markerChar === "x" ||
      markerChar === "X"
    ) {
      const failedTestMatch = failedTestNamePattern.exec(stripped);
      if (failedTestMatch) {
        this.lastFormat = "failed-test-name";
        this.lastMatch = failedTestMatch;
        return 0.85;
      }
    }

    // Stack frame - cache match for parse()
    if (
      stripped.includes("❯") ||
      stripped.includes(">") ||
      stripped.includes("at ")
    ) {
      const stackMatch =
        stackFramePattern.exec(stripped) ||
        stackFrameWithFuncPattern.exec(stripped);
      if (stackMatch) {
        // Filter out internal vitest runner frames - they're not useful for debugging
        const file = stackMatch[1];
        if (file && vitestInternalFramePattern.test(file)) {
          return 0;
        }
        this.lastFormat = "stack-frame";
        this.lastMatch = stackMatch;
        return 0.8;
      }
    }

    return 0;
  }

  parse(line: string, ctx: ParseContext): ParseResult {
    // SECURITY: Skip overly long lines to prevent ReDoS attacks
    if (line.length > MAX_LINE_LENGTH) {
      return null;
    }

    const stripped = stripAnsi(line);

    // HACK: Use cached match if available and line matches (avoids double regex)
    if (stripped === this.lastStripped && this.lastFormat && this.lastMatch) {
      const format = this.lastFormat;
      const match = this.lastMatch;

      // Clear cache after use
      this.lastFormat = null;
      this.lastMatch = null;

      switch (format) {
        case "fail-marker":
          return this.parseFailMarker(match, line, ctx);
        case "test-file-summary":
          return this.parseTestFileSummary(match, line, ctx);
        case "assertion-error":
          this.startErrorBlock(match, line);
          return null;
        case "failed-test-name":
          return this.parseFailedTestName(match, line, ctx);
        case "stack-frame":
          if (!this.errorState.inError) {
            return this.parseStackFrame(match, line, ctx);
          }
          return null;
        default:
          break;
      }
    }

    // Clear stale cache
    this.lastFormat = null;
    this.lastMatch = null;

    // Handle FAIL marker
    const failMatch = failMarkerPattern.exec(stripped);
    if (failMatch) {
      return this.parseFailMarker(failMatch, line, ctx);
    }

    // Handle test file with failure summary
    const testFileSummaryMatch = testFileSummaryPattern.exec(stripped);
    if (testFileSummaryMatch) {
      return this.parseTestFileSummary(testFileSummaryMatch, line, ctx);
    }

    // Handle assertion error - start multi-line accumulation
    const assertionMatch = assertionErrorPattern.exec(stripped);
    if (assertionMatch) {
      this.startErrorBlock(assertionMatch, line);
      return null; // Wait for multi-line completion
    }

    // Handle failed test name
    const failedTestMatch = failedTestNamePattern.exec(stripped);
    if (failedTestMatch) {
      return this.parseFailedTestName(failedTestMatch, line, ctx);
    }

    // Handle stack frame as standalone error if not in multi-line mode
    const stackMatch =
      stackFramePattern.exec(stripped) ||
      stackFrameWithFuncPattern.exec(stripped);
    if (stackMatch && !this.errorState.inError) {
      return this.parseStackFrame(stackMatch, line, ctx);
    }

    return null;
  }

  isNoise(line: string): boolean {
    // SECURITY: Skip overly long lines for performance
    if (line.length > MAX_LINE_LENGTH) {
      return false;
    }

    const stripped = stripAnsi(line);
    const lowerStripped = stripped.toLowerCase();

    // Fast prefix checks
    for (const prefix of noiseFastPrefixes) {
      if (lowerStripped.startsWith(prefix)) {
        return true;
      }
    }

    // Fast contains checks
    for (const substr of noiseFastContains) {
      if (lowerStripped.includes(substr)) {
        return true;
      }
    }

    // Regex patterns
    for (const pattern of noisePatterns) {
      if (pattern.test(stripped)) {
        return true;
      }
    }

    return false;
  }

  continueMultiLine(line: string, _ctx: ParseContext): boolean {
    if (!this.errorState.inError) {
      return false;
    }
    // SECURITY: Skip overly long lines to prevent ReDoS attacks
    if (line.length > MAX_LINE_LENGTH) {
      return false;
    }
    return this.continueErrorBlock(line);
  }

  finishMultiLine(ctx: ParseContext): ParseResult {
    if (!this.errorState.inError) {
      return null;
    }
    return this.finishErrorBlock(ctx);
  }

  reset(): void {
    resetErrorState(this.errorState);
    this.lastStripped = "";
    this.lastFormat = null;
    this.lastMatch = null;
  }

  noisePatterns(): NoisePatterns {
    return {
      fastPrefixes: noiseFastPrefixes,
      fastContains: noiseFastContains,
      regex: noisePatterns,
    };
  }

  // ============================================================================
  // Private Methods - Multi-line Error Handling
  // ============================================================================

  private pushErrorLine(line: string): void {
    this.errorState.raw.push(line);
    this.errorState.byteCount += line.length + 1;
  }

  private startErrorBlock(matches: RegExpExecArray, rawLine: string): void {
    const [, errorType, message] = matches;

    this.errorState.inError = true;
    this.errorState.errorType = errorType;
    this.errorState.message = message || "";
    this.errorState.raw = [rawLine];
    this.errorState.byteCount = rawLine.length;
    this.errorState.frameCount = 0;
    this.errorState.stackTrace = [];
    this.errorState.diffLines = [];
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parser state machine requires multiple pattern checks for Vitest error accumulation
  private continueErrorBlock(line: string): boolean {
    const stripped = stripAnsi(line);

    // SECURITY: Check resource limits to prevent memory exhaustion
    if (
      this.errorState.frameCount >= MAX_STACK_FRAMES ||
      this.errorState.byteCount >= MAX_TRACEBACK_BYTES ||
      this.errorState.raw.length >= MAX_RAW_LINES
    ) {
      return false;
    }

    // HACK: Fast path for empty lines - very common in error blocks
    if (stripped.trim() === "") {
      this.pushErrorLine(line);
      return true;
    }

    // HACK: Fast path check for separator characters before running regex
    const firstChar = stripped[0];
    if (
      (firstChar === "⎯" || firstChar === "─") &&
      errorBlockSeparator.test(stripped)
    ) {
      return false;
    }

    // HACK: Fast path for FAIL - check includes before regex
    if (stripped.includes("FAIL") && failMarkerPattern.test(stripped)) {
      return false;
    }

    // HACK: Fast path for assertion errors - check first char before regex
    if (
      (firstChar === "A" ||
        firstChar === "E" ||
        firstChar === "T" ||
        firstChar === "R" ||
        firstChar === "S" ||
        firstChar === "U") &&
      stripped.includes(": ") &&
      assertionErrorPattern.test(stripped)
    ) {
      return false;
    }

    // HACK: Fast path for passing test markers - check first char
    if (
      (firstChar === "✓" || firstChar === "√" || firstChar === "✔") &&
      testFileHeaderPattern.test(stripped)
    ) {
      return false;
    }

    // Stack frame - extract location with fast path check
    if (
      stripped.includes("❯") ||
      stripped.includes(">") ||
      stripped.includes("at ")
    ) {
      const stackMatch =
        stackFramePattern.exec(stripped) ||
        stackFrameWithFuncPattern.exec(stripped);
      if (stackMatch) {
        const [, file, lineStr, colStr] = stackMatch;
        if (file && lineStr && colStr) {
          // Keep the first (deepest) stack frame
          if (!this.errorState.file) {
            this.errorState.file = file;
            this.errorState.line = Number.parseInt(lineStr, 10);
            this.errorState.column = Number.parseInt(colStr, 10);
          }
          this.errorState.stackTrace.push(line);
          this.errorState.frameCount++;
        }
        this.pushErrorLine(line);
        return true;
      }
    }

    // Diff lines - fast path: check for - or + prefix
    if (
      (firstChar === "-" || firstChar === "−" || firstChar === "+") &&
      (diffExpectedPattern.test(stripped) || diffReceivedPattern.test(stripped))
    ) {
      this.errorState.diffLines.push(stripped);
      this.pushErrorLine(line);
      return true;
    }

    // expect() call context - fast path: check for expect prefix
    if (
      stripped.trimStart().startsWith("expect(") &&
      expectCallPattern.test(stripped)
    ) {
      this.pushErrorLine(line);
      return true;
    }

    // Code context lines (indented) - fast path: check whitespace prefix
    if (
      (firstChar === " " || firstChar === "\t") &&
      codeContextPattern.test(stripped)
    ) {
      this.pushErrorLine(line);
      return true;
    }

    // For unrecognized lines, use heuristics to determine if they're error context
    // Lines with error-like content (objects, values, keywords) are more likely relevant
    if (errorContextHeuristicPattern.test(stripped)) {
      this.pushErrorLine(line);
      return true;
    }

    // Be lenient for a few initial lines even without heuristic match,
    // as error blocks often have varied formatting
    if (this.errorState.raw.length < 10) {
      this.pushErrorLine(line);
      return true;
    }

    return false;
  }

  private finishErrorBlock(ctx: ParseContext): ParseResult {
    const stackTrace =
      this.errorState.stackTrace.length > 0
        ? this.errorState.stackTrace.join("\n")
        : undefined;

    // Prepend error type to message for complete error context.
    // The message field only contains text after "ErrorType: " from the regex,
    // so we reconstruct the full error format here.
    let message = this.errorState.errorType
      ? `${this.errorState.errorType}: ${this.errorState.message}`
      : this.errorState.message;

    const messageTruncated = message.length > MAX_MESSAGE_LENGTH;
    message = truncateMessage(message);

    const stackTraceTruncated =
      this.errorState.frameCount >= MAX_STACK_FRAMES ||
      this.errorState.byteCount >= MAX_TRACEBACK_BYTES;

    const err: MutableExtractedError = {
      message,
      file: this.errorState.file,
      line: this.errorState.line,
      column: this.errorState.column,
      severity: "error",
      raw: this.errorState.raw.join("\n"),
      stackTrace,
      category: "test",
      source: "vitest",
      lineKnown: this.errorState.line !== undefined && this.errorState.line > 0,
      columnKnown:
        this.errorState.column !== undefined && this.errorState.column > 0,
      stackTraceTruncated,
      messageTruncated,
    };

    applyWorkflowContext(err, ctx);
    this.reset();
    return err;
  }

  // ============================================================================
  // Private Methods - Single-line Parsers
  // ============================================================================

  private parseFailMarker(
    matches: RegExpExecArray,
    rawLine: string,
    ctx: ParseContext
  ): ParseResult {
    const [, file] = matches;

    const err: MutableExtractedError = {
      message: `Test suite failed: ${file}`,
      file,
      severity: "error",
      raw: rawLine,
      category: "test",
      source: "vitest",
      lineKnown: false,
      columnKnown: false,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }

  private parseTestFileSummary(
    matches: RegExpExecArray,
    rawLine: string,
    ctx: ParseContext
  ): ParseResult {
    const [, file, failedCount] = matches;

    const err: MutableExtractedError = {
      message: `Test file failed: ${file} (${failedCount} failed)`,
      file,
      severity: "error",
      raw: rawLine,
      category: "test",
      source: "vitest",
      lineKnown: false,
      columnKnown: false,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }

  private parseFailedTestName(
    matches: RegExpExecArray,
    rawLine: string,
    ctx: ParseContext
  ): ParseResult {
    const [, testName] = matches;

    const err: MutableExtractedError = {
      message: `Test failed: ${testName}`,
      severity: "error",
      raw: rawLine,
      category: "test",
      source: "vitest",
      ruleId: testName,
      lineKnown: false,
      columnKnown: false,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }

  private parseStackFrame(
    matches: RegExpExecArray,
    rawLine: string,
    ctx: ParseContext
  ): ParseResult {
    const [, file, lineStr, colStr] = matches;
    if (!(file && lineStr && colStr)) {
      return null;
    }

    // Filter out internal vitest runner frames - they're not useful for debugging.
    // Users care about their test code, not the test runner's internal stack.
    // This follows Vitest's own onStackTrace recommendation to filter node_modules.
    if (vitestInternalFramePattern.test(file)) {
      return null;
    }

    const lineNum = Number.parseInt(lineStr, 10);
    const col = Number.parseInt(colStr, 10);

    const err: MutableExtractedError = {
      message: `Error at ${file}:${lineNum}:${col}`,
      file,
      line: lineNum,
      column: col,
      severity: "error",
      raw: rawLine,
      category: "test",
      source: "vitest",
      lineKnown: lineNum > 0,
      columnKnown: col > 0,
    };

    applyWorkflowContext(err, ctx);
    return err;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export const createVitestParser = (): VitestParser => new VitestParser();
