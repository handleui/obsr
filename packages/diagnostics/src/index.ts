// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point
import { detectTool } from "./detect.js";
import { parseCargo } from "./parsers/cargo.js";
import { parseEslint } from "./parsers/eslint.js";
import { parseGolangci } from "./parsers/golangci.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseVitest } from "./parsers/vitest.js";
import type {
  DetectedTool,
  Diagnostic,
  DiagnosticResult,
  DiagnosticSummary,
  Parser,
} from "./types.js";

export {
  type AsyncParser,
  createParser,
  type ParserOptions,
} from "./client.js";
export { detectTool } from "./detect.js";
export { parseCargo } from "./parsers/cargo.js";
export { parseEslint } from "./parsers/eslint.js";
export { parseGolangci } from "./parsers/golangci.js";
export { parseTypeScript } from "./parsers/typescript.js";
export { parseVitest } from "./parsers/vitest.js";
export {
  DETECTED_TOOLS,
  type DetectedTool,
  type Diagnostic,
  type DiagnosticResult,
  type DiagnosticSummary,
  isDetectedTool,
  type Parser,
  type Severity,
} from "./types.js";

export const PARSERS: Record<DetectedTool, Parser> = {
  eslint: parseEslint,
  vitest: parseVitest,
  typescript: parseTypeScript,
  cargo: parseCargo,
  golangci: parseGolangci,
};

/**
 * Create a fresh empty result to avoid shared mutable state.
 * Prevents bugs if consumers accidentally mutate the result.
 */
const createEmptyResult = (): DiagnosticResult => ({
  detectedTool: null,
  diagnostics: [],
  summary: { total: 0, errors: 0, warnings: 0 },
});

const computeSummary = (diagnostics: Diagnostic[]): DiagnosticSummary => {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") {
      errors++;
    } else if (d.severity === "warning") {
      warnings++;
    }
  }
  return {
    total: diagnostics.length,
    errors,
    warnings,
  };
};

/**
 * Mutable parser registry (starts with built-in parsers).
 * Uses direct Map initialization to avoid Object.entries() intermediate array allocation.
 */
const parserRegistry = new Map<string, Parser>([
  ["eslint", parseEslint],
  ["vitest", parseVitest],
  ["typescript", parseTypeScript],
  ["cargo", parseCargo],
  ["golangci", parseGolangci],
]);

/**
 * Register a custom parser for a tool not natively supported.
 * Once registered, `extract()` will use this parser when the tool name is provided.
 */
export const registerParser = (name: string, parser: Parser): void => {
  parserRegistry.set(name, parser);
};

/**
 * Get a parser by name from the registry.
 */
export const getParser = (name: string): Parser | undefined => {
  return parserRegistry.get(name);
};

/**
 * Extract diagnostics from CI tool output.
 * Auto-detects the tool if not specified.
 */
export const extract = (content: string, tool?: string): DiagnosticResult => {
  const detectedTool = tool ?? detectTool(content);

  if (!detectedTool) {
    return createEmptyResult();
  }

  const parser = parserRegistry.get(detectedTool);
  if (!parser) {
    return createEmptyResult();
  }

  const diagnostics = parser(content);

  return {
    detectedTool,
    diagnostics,
    summary: computeSummary(diagnostics),
  };
};
