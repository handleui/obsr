import { detectTool } from "./detect.js";
import { parseCargo } from "./parsers/cargo.js";
import { parseEslint } from "./parsers/eslint.js";
import { parseGolangci } from "./parsers/golangci.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseVitest } from "./parsers/vitest.js";
import type {
  Diagnostic,
  DiagnosticResult,
  DiagnosticSummary,
  Parser,
} from "./types.js";

const parserRegistry = new Map<string, Parser>([
  ["eslint", parseEslint],
  ["vitest", parseVitest],
  ["typescript", parseTypeScript],
  ["cargo", parseCargo],
  ["golangci", parseGolangci],
]);

export const registerParser = (name: string, parser: Parser): void => {
  parserRegistry.set(name, parser);
};

export const getParser = (name: string): Parser | undefined => {
  return parserRegistry.get(name);
};

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
  return { total: diagnostics.length, errors, warnings };
};

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
  return { detectedTool, diagnostics, summary: computeSummary(diagnostics) };
};
