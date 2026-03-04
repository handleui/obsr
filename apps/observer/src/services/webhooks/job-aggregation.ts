import type { Env } from "../../types/env";
import { formatErrorsFoundComment } from "../comment-formatter";
import { createGitHubService } from "../github";
import { deleteAndPostComment } from "../github/comments";
import { getProjectContextForComment } from "./db-operations";
import type { DbClient } from "./types";
import { safeLogValue } from "./types";

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

const buildAggregationResult = (
  stats: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    detentJobs: number;
    totalErrors: number;
    commentPosted?: boolean;
  } | null,
  overrides: Partial<AggregationResult> = {}
): AggregationResult => ({
  allComplete: false,
  shouldPostComment: false,
  commentPosted: stats?.commentPosted ?? false,
  totalJobs: stats?.totalJobs ?? 0,
  completedJobs: stats?.completedJobs ?? 0,
  failedJobs: stats?.failedJobs ?? 0,
  detentJobs: stats?.detentJobs ?? 0,
  totalErrors: stats?.totalErrors ?? 0,
  ...overrides,
});

export const checkAndTriggerAggregation = async (
  env: Env,
  db: DbClient,
  repository: string,
  commitSha: string
): Promise<AggregationResult> => {
  const stats = (await db.query("commit_job_stats:getByRepoCommit", {
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
    return buildAggregationResult(null);
  }

  const allComplete =
    stats.completedJobs >= stats.totalJobs && stats.totalJobs > 0;

  if (stats.commentPosted) {
    return buildAggregationResult(stats, { allComplete, commentPosted: true });
  }

  if (!allComplete) {
    return buildAggregationResult(stats);
  }

  const shouldPostComment = stats.totalErrors > 0 && stats.detentJobs > 0;

  if (!shouldPostComment) {
    return buildAggregationResult(stats, { allComplete: true });
  }

  if (!stats.prNumber) {
    console.log(
      `[job-aggregation] All jobs complete but no PR number found for ${repository}@${commitSha.slice(0, 7)}`
    );
    return buildAggregationResult(stats, {
      allComplete: true,
      shouldPostComment: true,
    });
  }

  const posted = await postAggregatedComment(
    env,
    db,
    repository,
    stats.prNumber,
    stats.totalErrors,
    stats.detentJobs
  );

  if (posted) {
    await db.mutation("commit_job_stats:setCommentPostedByRepoCommit", {
      repository,
      commitSha,
      commentPosted: true,
    });
  }

  return buildAggregationResult(stats, {
    allComplete: true,
    shouldPostComment: true,
    commentPosted: posted,
  });
};

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
    console.error(
      `[job-aggregation] Invalid repository format: ${safeLogValue(repository)}`
    );
    return false;
  }

  const context = await getProjectContextForComment(db, repository);
  if (!context) {
    console.log(
      `[job-aggregation] Project not found for ${repository}, skipping comment`
    );
    return false;
  }

  const appBaseUrl =
    env.APP_BASE_URL ?? env.NAVIGATOR_BASE_URL ?? "https://detent.sh";
  const projectUrl = `${appBaseUrl}/dashboard/${context.projectId}`;

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
