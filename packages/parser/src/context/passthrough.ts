/**
 * Passthrough context parser.
 * Passes lines through unchanged without any CI-specific processing.
 * Use this when parsing raw log output without CI prefixes.
 *
 * This parser is STATELESS - it simply passes lines through.
 */

import type { ContextParser, ParseLineResult } from "./types.js";

/**
 * Create a passthrough context parser.
 * Lines pass through unchanged with empty context.
 * This parser is stateless; reset() is a no-op.
 */
export const createPassthroughParser = (): ContextParser => ({
  parseLine(line: string): ParseLineResult {
    return {
      ctx: { job: "", step: "", isNoise: false },
      cleanLine: line,
      skip: false,
    };
  },
  reset(): void {
    // No state to reset - passthrough parser is stateless
  },
});

/**
 * Singleton instance for convenience.
 * Safe to share since this parser is stateless.
 */
export const passthroughParser: ContextParser = createPassthroughParser();
