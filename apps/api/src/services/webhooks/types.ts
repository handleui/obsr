import type { createDb } from "../../db/client";
import type { ParsedError } from "../error-parser";

export type DbClient = Awaited<ReturnType<typeof createDb>>["db"];

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
