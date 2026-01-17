/**
 * GitLab CI context parser.
 * Strips GitLab timestamp prefixes and passes lines through for tool parsing.
 *
 * PERFORMANCE NOTES:
 * - Regex is module-level constant (not recreated per call)
 * - Fast path: check if line starts with digit before regex matching
 * - Returns inline object literal for minimal allocation
 */

import type { CIProvider, ContextParser, ParseLineResult } from "./types.js";

/**
 * GitLab timestamp pattern: 2024-01-15T10:30:45.123Z
 * Format: YYYY-MM-DDTHH:MM:SS.sssZ followed by optional whitespace
 *
 * SECURITY: Bounded quantifiers to prevent ReDoS:
 * - Fractional seconds: 1-9 digits (GitLab uses 3, allowing flexibility)
 * - Trailing whitespace: 0-10 spaces
 */
const GITLAB_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z\s{0,10}/;

/**
 * Shared empty context object to avoid allocations in hot paths.
 * Frozen to prevent accidental mutation.
 * The cleanLine varies per call, so only the ctx portion is shared.
 */
const emptyCtx = Object.freeze({ job: "", step: "", isNoise: false });

/**
 * Create a GitLab CI context parser.
 * Strips ISO timestamp prefixes (e.g., "2024-01-15T10:30:45.123Z ") from lines.
 *
 * PERFORMANCE: This parser is optimized for the hot path (parseLine called per-line):
 * - Fast path skips regex if line doesn't start with a digit
 * - Module-level regex constant avoids per-call compilation
 * - Minimal object allocation in the return path
 */
export const createGitLabContextParser = (): ContextParser => ({
  parseLine: (line: string): ParseLineResult => {
    // Fast path: if line doesn't start with a digit, it can't have a timestamp
    // This avoids regex execution for lines without timestamps (common in CI output)
    const firstChar = line.charCodeAt(0);
    if (firstChar < 48 || firstChar > 57) {
      // Not 0-9: return with shared context object
      return { ctx: emptyCtx, cleanLine: line, skip: false };
    }

    // Strip timestamp prefix if present
    const cleaned = line.replace(GITLAB_TIMESTAMP_PATTERN, "");
    return { ctx: emptyCtx, cleanLine: cleaned, skip: false };
  },
  reset: (): void => {
    // No state to reset - GitLab parser is stateless
  },
});

export const gitlabProvider: CIProvider = {
  id: "gitlab",
  name: "GitLab CI",
  isStateful: false,
  priority: 10,
  description: "GitLab CI/CD pipeline runner",
  detectFromEnv: () => process.env.GITLAB_CI === "true",
  createContextParser: createGitLabContextParser,
};

/** Singleton instance for convenience. */
export const gitlabParser = createGitLabContextParser();
