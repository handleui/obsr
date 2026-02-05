import { fetchAllPages } from "../../lib/convex-pagination";
import type { DbClient } from "./types";

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

// HACK: Matrix builds have multiple jobs with the same name - consider matching by providerJobId
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

export const updateCommitJobStats = async (
  db: DbClient,
  repository: string,
  commitSha: string,
  prNumber?: number
): Promise<void> => {
  const [jobs, existing] = await Promise.all([
    fetchAllPages<{
      status: string;
      conclusion?: string | null;
      hasDetent?: boolean;
      errorCount?: number;
    }>(db, "jobs:paginateByRepoCommit", { repository, commitSha }),
    db.query("commit_job_stats:getByRepoCommit", {
      repository,
      commitSha,
    }) as Promise<{ commentPosted?: boolean } | null>,
  ]);

  if (jobs.length === 0) {
    return;
  }

  let completedJobs = 0;
  let failedJobs = 0;
  let detentJobs = 0;
  let totalErrors = 0;

  for (const job of jobs) {
    if (job.status === "completed") {
      completedJobs++;
    }
    if (job.conclusion === "failure") {
      failedJobs++;
    }
    if (job.hasDetent) {
      detentJobs++;
      totalErrors += job.errorCount ?? 0;
    }
  }

  const now = Date.now();
  await db.mutation("commit_job_stats:upsert", {
    repository,
    commitSha,
    prNumber,
    totalJobs: jobs.length,
    completedJobs,
    failedJobs,
    detentJobs,
    totalErrors,
    commentPosted: existing?.commentPosted ?? false,
    createdAt: now,
    updatedAt: now,
  });
};
