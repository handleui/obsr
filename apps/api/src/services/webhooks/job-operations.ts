import { fetchAllPages } from "../../lib/convex-pagination";
import type { DbClient } from "./types";

// ============================================================================
// Job Tracking Operations (for workflow_job webhook)
// ============================================================================

/**
 * Look up PR number from runs table for a given commit.
 * GitHub workflow_job webhook doesn't include PR info, so we look it up
 * from previously stored run data (from workflow_run webhook).
 */
export const lookupPrNumberFromRuns = async (
  db: DbClient,
  repository: string,
  commitSha: string
): Promise<number | undefined> => {
  const runs = (await db.query("runs:listByRepoCommit", {
    repository,
    commitSha,
  })) as Array<{ prNumber?: number | null }>;

  const match = runs.find((run) => typeof run.prNumber === "number");
  return match?.prNumber ?? undefined;
};

type JobStatus =
  | "queued"
  | "waiting"
  | "in_progress"
  | "completed"
  | "pending"
  | "requested";
type JobConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | null;

export interface UpsertJobData {
  providerJobId: string;
  repository: string;
  commitSha: string;
  name: string;
  workflowName: string | null;
  status: JobStatus;
  conclusion: JobConclusion;
  htmlUrl: string;
  runnerName: string | null;
  headBranch: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  prNumber?: number;
}

/**
 * Upsert a job record. Creates new job or updates existing one.
 * Uses ON CONFLICT DO UPDATE for idempotency.
 */
export const upsertJob = async (
  db: DbClient,
  data: UpsertJobData
): Promise<void> => {
  await db.mutation("jobs:upsertByRepoJob", {
    repository: data.repository,
    providerJobId: data.providerJobId,
    data: {
      providerJobId: data.providerJobId,
      repository: data.repository,
      commitSha: data.commitSha,
      prNumber: data.prNumber,
      name: data.name,
      workflowName: data.workflowName ?? undefined,
      status: data.status,
      conclusion: data.conclusion ?? undefined,
      hasDetent: false,
      errorCount: 0,
      htmlUrl: data.htmlUrl,
      runnerName: data.runnerName ?? undefined,
      headBranch: data.headBranch ?? undefined,
      queuedAt: data.queuedAt ? data.queuedAt.getTime() : undefined,
      startedAt: data.startedAt ? data.startedAt.getTime() : undefined,
      completedAt: data.completedAt ? data.completedAt.getTime() : undefined,
    },
  });
};

/**
 * Mark a job as having Detent action and set error count.
 * Called from POST /report when action reports errors.
 *
 * TODO: Matrix builds have multiple jobs with the same name (e.g., "build" for node 18, 20, 22).
 * Consider matching by providerJobId instead for precise matching. This requires the action
 * to pass GITHUB_RUN_ID in the report payload.
 */
export const markJobAsDetent = async (
  db: DbClient,
  repository: string,
  commitSha: string,
  jobName: string,
  errorCount: number
): Promise<boolean> => {
  const updated = (await db.mutation("jobs:markDetentByRepoCommitName", {
    repository,
    commitSha,
    name: jobName,
    errorCount,
  })) as number;
  return updated > 0;
};

/**
 * Recompute and update commit job stats from jobs table.
 * Called after each job upsert to keep stats in sync.
 */
export const updateCommitJobStats = async (
  db: DbClient,
  repository: string,
  commitSha: string,
  prNumber?: number
): Promise<void> => {
  const jobs = await fetchAllPages<{
    status: string;
    conclusion?: string | null;
    hasDetent?: boolean;
    errorCount?: number;
  }>(db, "jobs:paginateByRepoCommit", { repository, commitSha });

  if (jobs.length === 0) {
    return;
  }

  const totalJobs = jobs.length;
  const completedJobs = jobs.filter((job) => job.status === "completed").length;
  const failedJobs = jobs.filter((job) => job.conclusion === "failure").length;
  const detentJobs = jobs.filter((job) => job.hasDetent).length;
  const totalErrors = jobs.reduce((sum, job) => {
    if (!job.hasDetent) {
      return sum;
    }
    return sum + (job.errorCount ?? 0);
  }, 0);

  const existing = (await db.query("commit_job_stats:getByRepoCommit", {
    repository,
    commitSha,
  })) as { commentPosted?: boolean } | null;

  const now = Date.now();
  await db.mutation("commit_job_stats:upsert", {
    repository,
    commitSha,
    prNumber,
    totalJobs,
    completedJobs,
    failedJobs,
    detentJobs,
    totalErrors,
    commentPosted: existing?.commentPosted ?? false,
    createdAt: now,
    updatedAt: now,
  });
};
