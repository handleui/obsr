import type { ConvexHttpClient } from "convex/browser";

export type DbClient = ConvexHttpClient;

export interface ParsedError {
  filePath?: string;
  line?: number;
  column?: number;
  message: string;
  category?: string;
  severity?: string;
  ruleId?: string;
  source?: string;
  stackTrace?: string;
  workflowJob?: string;
  workflowStep?: string;
  workflowAction?: string;
  /** True if matched by generic fallback parser */
  unknownPattern?: boolean;
  /** True if error may be test output noise (vitest/jest progress, etc.) */
  possiblyTestOutput?: boolean;
  /** Hints for fixing the error (merged from legacy suggestions + hint fields) */
  hints?: string[];
  /** Code snippet with surrounding context */
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  };
  /** Confidence flag for line number */
  lineKnown?: boolean;
  /** True if error can be auto-fixed by the tool */
  fixable?: boolean;
}

export interface PreparedRunData {
  runRecordId: string;
  runId: number;
  runName: string;
  prNumber: number;
  headSha: string;
  errors: ParsedError[];
  repository: string;
  checkRunId: number | null;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
  /** Project ID for occurrence tracking (optional, avoids extra DB query if provided) */
  projectId?: string;
}

export interface RunIdentifier {
  runId: number;
  runAttempt: number;
}

export interface WorkflowRunMeta {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
  event: string;
}
