import { and, eq, isNotNull, sql } from "drizzle-orm";
import { commitJobStats, jobs, runs } from "../../db/schema";
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
  const result = await db
    .select({ prNumber: runs.prNumber })
    .from(runs)
    .where(
      and(
        eq(runs.repository, repository),
        eq(runs.commitSha, commitSha),
        isNotNull(runs.prNumber)
      )
    )
    .limit(1);

  return result[0]?.prNumber ?? undefined;
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
  await db
    .insert(jobs)
    .values({
      id: crypto.randomUUID(),
      providerJobId: data.providerJobId,
      repository: data.repository,
      commitSha: data.commitSha,
      prNumber: data.prNumber,
      name: data.name,
      workflowName: data.workflowName,
      status: data.status,
      conclusion: data.conclusion,
      htmlUrl: data.htmlUrl,
      runnerName: data.runnerName,
      headBranch: data.headBranch,
      queuedAt: data.queuedAt,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
    })
    .onConflictDoUpdate({
      target: [jobs.repository, jobs.providerJobId],
      set: {
        name: data.name,
        workflowName: data.workflowName,
        status: data.status,
        conclusion: data.conclusion,
        htmlUrl: data.htmlUrl,
        runnerName: data.runnerName,
        headBranch: data.headBranch,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        prNumber: data.prNumber,
        updatedAt: new Date(),
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
  const result = await db
    .update(jobs)
    .set({
      hasDetent: true,
      errorCount,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.repository, repository),
        eq(jobs.commitSha, commitSha),
        eq(jobs.name, jobName)
      )
    );

  return (result.rowCount ?? 0) > 0;
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
  // Aggregate stats from jobs table
  const jobStats = await db
    .select({
      totalJobs: sql<number>`count(*)::int`,
      completedJobs: sql<number>`count(*) filter (where ${jobs.status} = 'completed')::int`,
      failedJobs: sql<number>`count(*) filter (where ${jobs.conclusion} = 'failure')::int`,
      detentJobs: sql<number>`count(*) filter (where ${jobs.hasDetent} = true)::int`,
      totalErrors: sql<number>`coalesce(sum(${jobs.errorCount}) filter (where ${jobs.hasDetent} = true), 0)::int`,
    })
    .from(jobs)
    .where(and(eq(jobs.repository, repository), eq(jobs.commitSha, commitSha)));

  const stats = jobStats[0];
  if (!stats) {
    return;
  }

  // Upsert stats record
  await db
    .insert(commitJobStats)
    .values({
      id: crypto.randomUUID(),
      repository,
      commitSha,
      prNumber,
      totalJobs: stats.totalJobs,
      completedJobs: stats.completedJobs,
      failedJobs: stats.failedJobs,
      detentJobs: stats.detentJobs,
      totalErrors: stats.totalErrors,
    })
    .onConflictDoUpdate({
      target: [commitJobStats.repository, commitJobStats.commitSha],
      set: {
        totalJobs: stats.totalJobs,
        completedJobs: stats.completedJobs,
        failedJobs: stats.failedJobs,
        detentJobs: stats.detentJobs,
        totalErrors: stats.totalErrors,
        prNumber: prNumber ?? sql`${commitJobStats.prNumber}`,
        updatedAt: new Date(),
      },
    });
};
