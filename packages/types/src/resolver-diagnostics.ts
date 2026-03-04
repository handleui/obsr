import type { ErrorCategory } from "./category.js";
import type { ErrorSeverity } from "./severity.js";

export interface ResolverDiagnostic {
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  ruleId: string | null;
  severity: ErrorSeverity | null;
  category: ErrorCategory | null;
  signatureId: string | null;
  fixable: boolean;
}

export interface ResolverDiagnosticsContext {
  runId: string;
  projectId: string;
  commitSha: string | null;
  prNumber: number | null;
  jobName: string | null;
  source: string;
  logRef: string | null;
  diagnostics: ResolverDiagnostic[];
}
