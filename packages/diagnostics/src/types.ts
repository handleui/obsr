export type Severity = "error" | "warning";

export interface Diagnostic {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: Severity;
  ruleId?: string;
  stackTrace?: string;
  suggestions?: string[];
  fixable?: boolean;
}

export type DetectedTool =
  | "eslint"
  | "vitest"
  | "typescript"
  | "cargo"
  | "golangci";

export const DETECTED_TOOLS: readonly DetectedTool[] = [
  "eslint",
  "vitest",
  "typescript",
  "cargo",
  "golangci",
] as const;

export interface DiagnosticSummary {
  total: number;
  errors: number;
  warnings: number;
}

export interface DiagnosticResult {
  detectedTool: DetectedTool | null;
  diagnostics: Diagnostic[];
  summary: DiagnosticSummary;
}

export type Parser = (content: string) => Diagnostic[];
