import type { Env } from "../../types/env";
import { formatErrorsFoundComment } from "../comment-formatter";
import { createGitHubService } from "../github";
import { deleteAndPostComment } from "../github/comments";
import { getProjectContextForComment } from "./db-operations";
import type { DbClient } from "./types";

// ============================================================================
// Job Aggregation Logic
// ============================================================================
// Checks if all jobs for a commit have completed and triggers comment posting
// when all jobs are done. Only posts if at least one Detent-enabled job failed.

// SECURITY: Truncate strings in logs to prevent log injection
const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

export interface AggregationResult {
  allComplete: boolean;
  shouldPostComment: boolean;
  commentPosted: boolean;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  detentJobs: number;
  totalErrors: number;
}

/**
 * Check if all jobs for a commit have completed and trigger comment posting.
 *
 * This is called from two places:
 * 1. workflow_job.completed webhook - when a job finishes
 * 2. POST /report - when Detent action reports errors
 *
 * Idempotency: Uses commentPosted flag in commit_job_stats to prevent duplicate comments.
 *
 * Performance: Single query retrieves stats + prNumber from commitJobStats table.
 * The prNumber is denormalized on commitJobStats to avoid JOIN with jobs table.
 */
export const checkAndTriggerAggregation = async (
  env: Env,
  db: DbClient,
  repository: string,
  commitSha: string
): Promise<AggregationResult> => {
  // Single query: stats + prNumber are both on commitJobStats table
  const stats = (await db.query("commit-job-stats:getByRepoCommit", {
    repository,
    commitSha,
  })) as {
    prNumber?: number;
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    detentJobs: number;
    totalErrors: number;
    commentPosted?: boolean;
  } | null;

  if (!stats) {
    // No stats record yet - likely first job event
    return {
      allComplete: false,
      shouldPostComment: false,
      commentPosted: false,
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      detentJobs: 0,
      totalErrors: 0,
    };
  }

  // Check if all jobs are complete
  // NOTE: Race condition trade-off - GitHub may queue additional jobs (conditional, dependent)
  // after this check passes. We accept this for faster feedback; the commentPosted flag
  // prevents duplicates, and late jobs will still be tracked in the dashboard.
  const allComplete =
    stats.completedJobs >= stats.totalJobs && stats.totalJobs > 0;

  // Already posted? Return early
  if (stats.commentPosted) {
    return {
      allComplete,
      shouldPostComment: false,
      commentPosted: true,
      totalJobs: stats.totalJobs,
      completedJobs: stats.completedJobs,
      failedJobs: stats.failedJobs,
      detentJobs: stats.detentJobs,
      totalErrors: stats.totalErrors,
    };
  }

  // Not all complete? Return and wait
  if (!allComplete) {
    return {
      allComplete: false,
      shouldPostComment: false,
      commentPosted: false,
      totalJobs: stats.totalJobs,
      completedJobs: stats.completedJobs,
      failedJobs: stats.failedJobs,
      detentJobs: stats.detentJobs,
      totalErrors: stats.totalErrors,
    };
  }

  // All complete - should we post a comment?
  // Only post if there are errors from Detent-enabled jobs
  const shouldPostComment = stats.totalErrors > 0 && stats.detentJobs > 0;

  if (!shouldPostComment) {
    return {
      allComplete: true,
      shouldPostComment: false,
      commentPosted: false,
      totalJobs: stats.totalJobs,
      completedJobs: stats.completedJobs,
      failedJobs: stats.failedJobs,
      detentJobs: stats.detentJobs,
      totalErrors: stats.totalErrors,
    };
  }

  // prNumber is denormalized on commitJobStats - no extra query needed
  if (!stats.prNumber) {
    console.log(
      `[job-aggregation] All jobs complete but no PR number found for ${repository}@${commitSha.slice(0, 7)}`
    );
    return {
      allComplete: true,
      shouldPostComment: true,
      commentPosted: false,
      totalJobs: stats.totalJobs,
      completedJobs: stats.completedJobs,
      failedJobs: stats.failedJobs,
      detentJobs: stats.detentJobs,
      totalErrors: stats.totalErrors,
    };
  }

  // Post the comment
  const posted = await postAggregatedComment(
    env,
    db,
    repository,
    stats.prNumber,
    stats.totalErrors,
    stats.detentJobs
  );

  if (posted) {
    // Mark as posted to prevent duplicates
    await db.mutation("commit-job-stats:setCommentPostedByRepoCommit", {
      repository,
      commitSha,
      commentPosted: true,
    });
  }

  return {
    allComplete: true,
    shouldPostComment: true,
    commentPosted: posted,
    totalJobs: stats.totalJobs,
    completedJobs: stats.completedJobs,
    failedJobs: stats.failedJobs,
    detentJobs: stats.detentJobs,
    totalErrors: stats.totalErrors,
  };
};

/**
 * Post aggregated errors comment to PR.
 */
const postAggregatedComment = async (
  env: Env,
  db: DbClient,
  repository: string,
  prNumber: number,
  totalErrors: number,
  detentJobCount: number
): Promise<boolean> => {
  const [owner, repo] = repository.split("/");
  if (!(owner && repo)) {
    // SECURITY: Truncate repository in log to prevent log injection
    console.error(
      `[job-aggregation] Invalid repository format: ${safeLogValue(repository)}`
    );
    return false;
  }

  // Get project context for comment posting
  const context = await getProjectContextForComment(db, repository);
  if (!context) {
    console.log(
      `[job-aggregation] Project not found for ${repository}, skipping comment`
    );
    return false;
  }

  const projectUrl = `${env.NAVIGATOR_BASE_URL}/dashboard/${context.projectId}`;

  const commentBody = formatErrorsFoundComment({
    errorCount: totalErrors,
    jobCount: detentJobCount,
    projectUrl,
  });

  try {
    const github = createGitHubService(env);
    const token = await github.getInstallationToken(context.installationId);
    const appId = Number.parseInt(env.GITHUB_APP_ID, 10);

    await deleteAndPostComment({
      github,
      token,
      kv: env["detent-idempotency"],
      db,
      owner,
      repo,
      repository,
      prNumber,
      commentBody,
      appId,
    });

    console.log(
      `[job-aggregation] Posted aggregated comment on ${repository}#${prNumber}: ${totalErrors} errors in ${detentJobCount} jobs`
    );
    return true;
  } catch (error) {
    console.error(
      `[job-aggregation] Failed to post comment on ${repository}#${prNumber}:`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
};
