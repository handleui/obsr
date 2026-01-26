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
  /** Tool name (built-in DetectedTool or custom registered parser name) */
  detectedTool: string | null;
  diagnostics: Diagnostic[];
  summary: DiagnosticSummary;
}

/** Type guard to check if a tool name is a built-in detected tool */
export const isDetectedTool = (tool: string | null): tool is DetectedTool =>
  tool !== null && DETECTED_TOOLS.includes(tool as DetectedTool);

export type Parser = (content: string) => Diagnostic[];
