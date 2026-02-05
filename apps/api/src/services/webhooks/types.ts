import type { CIError } from "@detent/types";
import type { ConvexHttpClient } from "convex/browser";

export type DbClient = ConvexHttpClient;

export interface PreparedRunData {
  runRecordId: string;
  runId: number;
  runName: string;
  prNumber: number;
  headSha: string;
  errors: CIError[];
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

export const SHA_REGEX = /^[a-fA-F0-9]{40}$/;
export const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
export const MAX_JOB_ID = Number.MAX_SAFE_INTEGER;

export const isValidJobId = (id: number): boolean =>
  Number.isInteger(id) && id > 0 && id <= MAX_JOB_ID;

export const isValidCommitSha = (sha: string): boolean => SHA_REGEX.test(sha);

export const isValidRepositoryFormat = (repo: string): boolean => {
  const parts = repo.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [owner, name] = parts;
  return (
    !!owner &&
    !!name &&
    owner.length <= 39 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(owner) &&
    GITHUB_NAME_PATTERN.test(name) &&
    !owner.includes("..") &&
    !name.includes("..")
  );
};

export const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
