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

const EMPTY_RESULT: DiagnosticResult = {
  detectedTool: null,
  diagnostics: [],
  summary: { total: 0, errors: 0, warnings: 0 },
};

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

export const extract = (
  content: string,
  tool?: DetectedTool
): DiagnosticResult => {
  const detectedTool = tool ?? detectTool(content);

  if (!detectedTool) {
    return EMPTY_RESULT;
  }

  const parser = PARSERS[detectedTool];
  const diagnostics = parser(content);

  return {
    detectedTool,
    diagnostics,
    summary: computeSummary(diagnostics),
  };
};
