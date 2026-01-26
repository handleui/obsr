// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point
import { parseCargo } from "./parsers/cargo.js";
import { parseEslint } from "./parsers/eslint.js";
import { parseGolangci } from "./parsers/golangci.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseVitest } from "./parsers/vitest.js";
import type { DetectedTool, Parser } from "./types.js";

export {
  type AsyncParser,
  createParser,
  type ParserOptions,
} from "./client.js";
export { detectTool } from "./detect.js";
export { extract, getParser, registerParser } from "./extract.js";
export { type FormatOptions, formatDiagnostics } from "./format.js";
export { parseCargo } from "./parsers/cargo.js";
export { parseEslint } from "./parsers/eslint.js";
export { parseGolangci } from "./parsers/golangci.js";
export { parseTypeScript } from "./parsers/typescript.js";
export { parseVitest } from "./parsers/vitest.js";
export { type PreparedCommand, prepareCommand } from "./prepare.js";
export { type RunOptions, type RunResult, run } from "./runner.js";
export {
  type CustomToolConfig,
  detectToolFromCommand,
  registerTool,
  registerToolConfig,
  type ToolConfig,
} from "./tools.js";
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
