import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../../../db/client";
import { projects } from "../../../db/schema";
import { formatErrorsFoundComment } from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import { deleteAndPostComment } from "../../../services/github/comments";
import {
  acquireCommitLock,
  releaseCommitLock,
} from "../../../services/idempotency";
import {
  checkForJobReportedErrors,
  checkRunsAndLoadOrgSettings,
} from "../../../services/webhooks/db-operations";
import type { WebhookContext, WorkflowRunPayload } from "../types";

// ============================================================================
// Workflow Run Processing
// ============================================================================
// Tracks workflow runs and posts errors-found comments when CI fails.
// Check runs are no longer created automatically - they are created when
// user triggers heal via @detentsh heal command.

// ============================================================================
// Handle workflow_run.in_progress
// ============================================================================
// No longer creates check runs - just logs for observability
// biome-ignore lint/suspicious/useAwait: async required for webhook handler type signature
export const handleWorkflowRunInProgress = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] In progress: ${repository.full_name} / ${workflow_run.name} [delivery: ${deliveryId}]`
  );

  return c.json({
    message: "skipped",
    reason: "automatic_check_runs_disabled",
  });
};

// ============================================================================
// Handle workflow_run.completed
// ============================================================================
// Tracks workflow completion and posts errors-found comment if errors detected.
// Users trigger heals via @detentsh heal command or from dashboard.
export const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] Completed: ${repository.full_name} / ${workflow_run.name} (${workflow_run.conclusion}) [delivery: ${deliveryId}]`
  );

  // Idempotency check: Prevent duplicate processing of same commit (KV-backed)
  const lockResult = await acquireCommitLock(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );
  if (!lockResult.acquired) {
    const state = lockResult.state;
    console.log(
      `[workflow_run] Commit ${headSha.slice(0, 7)} ${state?.processing ? "already being processed" : "already processed"}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: state?.processing ? "already processing" : "already processed",
      repository: repository.full_name,
      headSha,
    });
  }

  const github = createGitHubService(c.env);

  try {
    const token = await github.getInstallationToken(installation.id);

    // Get PR number (skip if no PR associated)
    const prFromPayload = workflow_run.pull_requests[0]?.number;
    const prNumber =
      prFromPayload ??
      (await github.getPullRequestForCommit(token, owner, repo, headSha));

    if (!prNumber) {
      console.log(
        `[workflow_run] No PR associated with ${workflow_run.name}, skipping [delivery: ${deliveryId}]`
      );
      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      return c.json({
        message: "skipped",
        reason: "no_pr",
        branch: workflow_run.head_branch,
      });
    }

    // Check if ALL workflow runs for this commit are done
    const {
      allCompleted,
      runs: workflowRuns,
      evaluation,
    } = await github.listWorkflowRunsForCommit(token, owner, repo, headSha);

    if (!allCompleted) {
      const completedCount =
        evaluation.ciRelevantRuns.length - evaluation.pendingCiRuns.length;
      console.log(
        `[workflow_run] Waiting for ${evaluation.pendingCiRuns.length} more runs (${completedCount} complete)`
      );
      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      return c.json({
        message: "waiting",
        completedCount,
        pendingCount: evaluation.pendingCiRuns.length,
      });
    }

    // Check which runs we've already processed
    const runIdentifiers = workflowRuns.map((r) => ({
      runId: r.id,
      runAttempt: r.runAttempt,
    }));

    const { allExist, existingRuns } = await checkRunsAndLoadOrgSettings(
      c.env,
      repository.full_name,
      runIdentifiers,
      installation.id
    );

    if (allExist) {
      console.log(
        `[workflow_run] All ${runIdentifiers.length} runs already processed`
      );
      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      return c.json({
        message: "already processed",
        runCount: runIdentifiers.length,
      });
    }

    // Filter to only runs that need processing
    const runsToProcess = workflowRuns.filter(
      (r) => !existingRuns.has(`${r.id}:${r.runAttempt}`)
    );

    console.log(
      `[workflow_run] Processing ${runsToProcess.length} new runs (${existingRuns.size} already stored)`
    );

    // Check for job-reported errors (stored via POST /report)
    const jobReportedErrors = await checkForJobReportedErrors(
      c.env,
      repository.full_name,
      runsToProcess
    );

    const failedRuns = runsToProcess.filter((r) => r.conclusion === "failure");
    const errorCount = jobReportedErrors?.length ?? 0;

    if (jobReportedErrors && jobReportedErrors.length > 0) {
      console.log(
        `[workflow_run] Found ${errorCount} errors from ${failedRuns.length} failed runs`
      );

      // Post errors-found comment if there are fixable errors
      const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
      await postErrorsFoundComment(c, {
        token,
        owner,
        repo,
        prNumber,
        errorCount,
        failedRunCount: failedRuns.length,
        appId,
      });
    } else if (failedRuns.length > 0) {
      console.log(
        `[workflow_run] ${failedRuns.length} failed runs but no errors reported - action may not be configured`
      );
    }

    // Release lock after processing
    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    return c.json({
      message: "workflow_run processed",
      repository: repository.full_name,
      prNumber,
      runsProcessed: runsToProcess.length,
      failedRuns: failedRuns.length,
      totalErrors: errorCount,
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error processing [delivery: ${deliveryId}]:`,
      error
    );

    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    return c.json(
      {
        message: "workflow_run error",
        error: error instanceof Error ? error.message : "Unknown error",
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};

// ============================================================================
// Post Errors Found Comment
// ============================================================================
// Posts a comment when CI fails with fixable errors.
// The comment includes a link to the dashboard and prompts user to @detentsh heal.

interface PostErrorsFoundContext {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  errorCount: number;
  failedRunCount: number;
  appId: number;
}

const postErrorsFoundComment = async (
  c: WebhookContext,
  ctx: PostErrorsFoundContext
): Promise<void> => {
  const { token, owner, repo, prNumber, errorCount, failedRunCount, appId } =
    ctx;
  const repositoryFullName = `${owner}/${repo}`;

  // Look up project to get the dashboard URL
  const { db, client } = await createDb(c.env);
  try {
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.providerRepoFullName, repositoryFullName),
        isNull(projects.removedAt)
      ),
    });

    if (!project) {
      console.log(
        `[workflow_run] Project not found for ${repositoryFullName}, skipping comment`
      );
      return;
    }

    // Construct project URL (dashboard URL) using configured base URL
    const projectUrl = `${c.env.NAVIGATOR_BASE_URL}/dashboard/${project.id}`;

    const commentBody = formatErrorsFoundComment({
      errorCount,
      jobCount: failedRunCount,
      projectUrl,
    });

    const github = createGitHubService(c.env);
    await deleteAndPostComment({
      github,
      token,
      kv: c.env["detent-idempotency"],
      db,
      owner,
      repo,
      repository: repositoryFullName,
      prNumber,
      commentBody,
      appId,
    });

    console.log(
      `[workflow_run] Posted errors-found comment on ${repositoryFullName}#${prNumber}`
    );
  } finally {
    await client.end();
  }
};
