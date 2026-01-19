import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { inArray } from "drizzle-orm";
import { createDb } from "../../../db/client";
import { runErrors, runs } from "../../../db/schema";
import { captureLockConflict, captureWebhookError } from "../../../lib/sentry";
import { orchestrateHeals } from "../../../services/autofix/orchestrator";
import {
  formatCheckRunOutput,
  formatResultsComment,
  formatWaitingCheckRunOutput,
} from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import {
  postOrUpdateComment,
  updateCommentToPassingState,
} from "../../../services/github/comments";
import {
  acquireCommitLock,
  acquirePrCommentLock,
  getStoredCheckRunId,
  releaseCommitLock,
  releasePrCommentLock,
  storeCheckRunId,
} from "../../../services/idempotency";
import {
  checkForJobReportedErrors,
  checkRunsAndLoadOrgSettings,
} from "../../../services/webhooks/db-operations";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { ParsedError } from "../../../services/webhooks/types";
import type { Env } from "../../../types/env";
import type { WebhookContext, WorkflowRunPayload } from "../types";
import {
  attemptCheckRunCleanup,
  handleAllRunsProcessedEarlyReturn,
  handleNoPrEarlyReturn,
  handleWaitingForRunsEarlyReturn,
} from "../utils/early-returns";
import { fetchJobDetailsWithRateLimit } from "../utils/job-fetcher";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";
import { postWaitingComment } from "../waiting-comment";

// ============================================================================
// Workflow Run Processing
// ============================================================================
// Handles workflow_run.in_progress and workflow_run.completed events.
// Architecture:
// - in_progress: Creates a "queued" check run so users see Detent is watching
// - completed: Waits for ALL workflow runs for a commit, then posts analysis

// ============================================================================
// Helper: Finalize check run and post PR comment with results
// ============================================================================
interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

const finalizeAndPostResults = async (
  env: Env,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  kv: KVNamespace,
  context: {
    owner: string;
    repo: string;
    repository: string;
    executionCtx: ExecutionContext;
    headSha: string;
    headCommitMessage?: string;
    prNumber: number;
    checkRunId: number;
    workflowRuns: WorkflowRun[];
    allErrors: ParsedError[];
    detectedUnsupportedTools: string[];
    // Feature settings
    enableInlineAnnotations: boolean;
    enablePrComments: boolean;
    // Workflow evaluation for determining skip status
    ciRelevantRunCount: number;
    // Observability
    deliveryId: string;
  }
): Promise<{
  runResults: Array<{
    name: string;
    id: number;
    conclusion: string;
    errorCount: number;
  }>;
  totalErrors: number;
}> => {
  const {
    owner,
    repo,
    repository,
    executionCtx,
    headSha,
    headCommitMessage,
    prNumber,
    checkRunId,
    workflowRuns,
    allErrors,
    detectedUnsupportedTools,
    enableInlineAnnotations,
    enablePrComments,
    ciRelevantRunCount,
    deliveryId,
  } = context;

  // Prepare run results for formatting
  const runResults = workflowRuns.map((r) => ({
    name: r.name,
    id: r.id,
    conclusion: r.conclusion ?? "unknown",
    errorCount: allErrors.filter((e) => e.workflowJob === r.name).length,
  }));

  const failedCount = workflowRuns.filter(
    (r) => r.conclusion === "failure"
  ).length;
  const hasFailed = failedCount > 0;
  const totalErrors = allErrors.length;

  // Determine conclusion: skipped if no CI-relevant workflows, failure if any failed, success otherwise
  const noValidWorkflows = ciRelevantRunCount === 0;
  const getConclusion = () => {
    if (noValidWorkflows) {
      return "skipped";
    }
    if (hasFailed) {
      return "failure";
    }
    return "success";
  };
  const conclusion = getConclusion();

  // Determine title based on conclusion
  const getTitle = () => {
    if (noValidWorkflows) {
      return "No CI workflows to analyze";
    }
    if (hasFailed) {
      return `${totalErrors} error${totalErrors !== 1 ? "s" : ""} found`;
    }
    return "All checks passed";
  };
  const title = getTitle();

  // Format check run output with summary, error details, and inline annotations
  const checkRunOutput = formatCheckRunOutput({
    owner,
    repo,
    headSha,
    runs: runResults,
    errors: allErrors,
    totalErrors,
    detectedUnsupportedTools,
  });

  // Update check run to completed
  await github.updateCheckRun(token, {
    owner,
    repo,
    checkRunId,
    status: "completed",
    conclusion,
    output: {
      title,
      summary: checkRunOutput.summary,
      text: checkRunOutput.text,
      // Only include annotations if enabled in org settings
      ...(enableInlineAnnotations && {
        annotations: checkRunOutput.annotations,
      }),
    },
  });

  // Skip PR comments if disabled in org settings
  if (!enablePrComments) {
    console.log(`[webhook] PR comments disabled for ${repository}`);
    return { runResults, totalErrors };
  }

  // Create DB connection (needed for both passing and failing cases)
  const { db, client } = await createDb(env);
  let lockAcquired = false;

  try {
    // When all checks pass, update existing comment to "passing" state
    // (only if a previous failure comment exists)
    if (!hasFailed) {
      const prLock = await acquirePrCommentLock(kv, repository, prNumber);
      if (!prLock.acquired) {
        // Structured logging for lock conflict observability
        const holderAgeSeconds = prLock.holderInfo
          ? Math.round(prLock.holderInfo.ageMs / 1000)
          : "unknown";
        console.log(
          `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber} ` +
            `[delivery: ${deliveryId}] [holder_age: ${holderAgeSeconds}s] ` +
            "[operation: passing_comment_update]"
        );

        // Track in Sentry for monitoring lock contention patterns
        captureLockConflict({
          lockType: "pr_comment",
          repository,
          prNumber,
          deliveryId,
          operation: "passing_comment_update",
          holderInfo: prLock.holderInfo,
        });

        return { runResults, totalErrors };
      }
      lockAcquired = true;

      await updateCommentToPassingState({
        github,
        token,
        kv,
        db,
        owner,
        repo,
        repository,
        prNumber,
        headSha,
        headCommitMessage,
        runs: runResults,
      });

      return { runResults, totalErrors };
    }

    // When checks fail, post or update the failure comment
    // Acquire PR comment lock to prevent race conditions
    // Note: KV locks are eventually consistent, so rare race conditions are possible.
    // The DB unique constraint on prComments table is the ultimate safety net.
    const prLock = await acquirePrCommentLock(kv, repository, prNumber);
    if (!prLock.acquired) {
      // Structured logging for lock conflict observability
      const holderAgeSeconds = prLock.holderInfo
        ? Math.round(prLock.holderInfo.ageMs / 1000)
        : "unknown";
      console.log(
        `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber} ` +
          `[delivery: ${deliveryId}] [holder_age: ${holderAgeSeconds}s] ` +
          `[operation: failure_comment_update] [errors: ${totalErrors}]`
      );

      // Track in Sentry for monitoring lock contention patterns
      // This is more critical than passing comment update since users won't see error details
      captureLockConflict({
        lockType: "pr_comment",
        repository,
        prNumber,
        deliveryId,
        operation: "failure_comment_update",
        holderInfo: prLock.holderInfo,
      });

      return { runResults, totalErrors };
    }
    lockAcquired = true;

    const commentBody = formatResultsComment({
      owner,
      repo,
      headSha,
      headCommitMessage,
      runs: runResults,
      errors: allErrors,
      totalErrors,
      detectedUnsupportedTools,
      checkRunId,
    });

    // Safety: formatResultsComment returns null if no failures
    // This shouldn't happen since we check hasFailed above, but handle gracefully
    if (!commentBody) {
      console.log(
        `[workflow_run] No comment body generated for PR #${prNumber}, skipping`
      );
      return { runResults, totalErrors };
    }

    const appId = Number.parseInt(env.GITHUB_APP_ID, 10);
    await postOrUpdateComment({
      github,
      token,
      kv,
      db,
      executionCtx,
      owner,
      repo,
      repository,
      prNumber,
      commentBody,
      appId,
    });
  } finally {
    await client.end();
    if (lockAcquired) {
      await releasePrCommentLock(kv, repository, prNumber);
    }
  }

  return { runResults, totalErrors };
};

// ============================================================================
// Handle workflow_run.in_progress
// ============================================================================
// Creates a "queued" check run to show users we're watching
//
// Performance optimization (Cloudflare Workers):
// - Creates check run immediately with minimal output (fast response to GitHub)
// - Fetches workflow list in background via waitUntil (non-blocking)
// - Updates check run with detailed workflow status asynchronously
export const handleWorkflowRunInProgress = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] In progress: ${repository.full_name} / ${workflow_run.name} [delivery: ${deliveryId}]`
  );

  const github = createGitHubService(c.env);

  // Check if we already created a check run for this commit
  const existingCheckRunId = await getStoredCheckRunId(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );

  // Even if check run exists, we should update it with current workflow status
  // The check_suite.requested handler may have fetched workflows before they were visible
  // IMPORTANT: Also post/update waiting comment here as backup - check_suite.requested
  // may have failed to post it (e.g., lock was held by previous workflow_run.completed)
  if (existingCheckRunId) {
    console.log(
      `[workflow_run] Check run ${existingCheckRunId} exists for ${headSha.slice(0, 7)}, updating with workflow status`
    );

    try {
      const token = await github.getInstallationToken(installation.id);

      // Get PR number for waiting comment
      let prNumber = workflow_run.pull_requests[0]?.number;
      if (!prNumber) {
        // For fork PRs, workflow_run.pull_requests is empty but commits API works
        // Convert null -> undefined to match optional chaining semantics above
        prNumber =
          (await github.getPullRequestForCommit(token, owner, repo, headSha)) ??
          undefined;
      }

      const { evaluation } = await github.listWorkflowRunsForCommit(
        token,
        owner,
        repo,
        headSha
      );

      // Always update check run with current workflow status
      // Even if 0 CI-relevant workflows found, we show diagnostic info
      const jobsByRunId =
        evaluation.ciRelevantRuns.length > 0
          ? await fetchJobDetailsWithRateLimit(
              github,
              token,
              owner,
              repo,
              evaluation,
              `workflow_run:${existingCheckRunId}`
            )
          : new Map();

      // Log diagnostic info when no CI-relevant workflows found
      if (evaluation.ciRelevantRuns.length === 0) {
        const totalRuns =
          evaluation.blacklistedRuns.length + evaluation.skippedRuns.length;
        console.log(
          `[workflow_run] No CI-relevant workflows for ${headSha.slice(0, 7)}: ` +
            `${evaluation.blacklistedRuns.length} blacklisted, ${evaluation.skippedRuns.length} skipped (non-CI events), ` +
            `${totalRuns} total filtered`
        );
      }

      const { title, summary } = formatWaitingCheckRunOutput({
        evaluation,
        jobsByRunId: jobsByRunId.size > 0 ? jobsByRunId : undefined,
      });
      await github.updateCheckRun(token, {
        owner,
        repo,
        checkRunId: existingCheckRunId,
        status: "in_progress",
        output: { title, summary },
      });
      console.log(
        `[workflow_run] Updated check run ${existingCheckRunId} with ${evaluation.ciRelevantRuns.length} CI-relevant workflows, ${jobsByRunId.size} with job details`
      );

      // Post/update waiting comment in background (non-blocking)
      // This ensures the PR comment shows "waiting" even if check_suite.requested failed
      if (prNumber) {
        const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
          deliveryId,
          repository: repository.full_name,
          installationId: installation.id,
        });
        waitUntilTracked(
          postWaitingComment({
            env: c.env,
            token,
            owner,
            repo,
            repository: repository.full_name,
            prNumber,
            headSha,
            headCommitMessage: workflow_run.head_commit?.message,
            deliveryId,
          }),
          { operation: "post_waiting_comment", prNumber }
        );
      }
    } catch (error) {
      // Non-fatal: check run exists, just couldn't update status
      console.error(
        `[workflow_run] Failed to update existing check run ${existingCheckRunId}:`,
        error
      );
    }

    return c.json({
      message: "check run already exists",
      checkRunId: existingCheckRunId,
    });
  }

  try {
    const token = await github.getInstallationToken(installation.id);

    // Get PR number from payload, or try commits API for fork PRs
    let prNumber = workflow_run.pull_requests[0]?.number;
    if (!prNumber) {
      // For fork PRs, workflow_run.pull_requests is empty but commits API works
      // Convert null -> undefined to match optional chaining semantics above
      prNumber =
        (await github.getPullRequestForCommit(token, owner, repo, headSha)) ??
        undefined;
    }

    // Skip if no PR associated (e.g., push to main branch)
    if (!prNumber) {
      console.log(
        `[workflow_run] No PR associated with ${workflow_run.name}, skipping [delivery: ${deliveryId}]`
      );
      return c.json({
        message: "skipped",
        reason: "no_pr",
        branch: workflow_run.head_branch,
      });
    }

    // Create a "queued" check run immediately with minimal output (fast webhook response)
    // The workflow list will be fetched in background and check run updated
    const checkRun = await github.createCheckRun(token, {
      owner,
      repo,
      headSha,
      name: "Detent Heal",
      status: "queued",
      output: {
        title: "Waiting for CI to complete",
        summary: "Monitoring workflow runs...",
      },
    });

    // Store the check run ID for later update
    await storeCheckRunId(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha,
      checkRun.id
    );

    console.log(
      `[workflow_run] Created queued check run ${checkRun.id} for ${headSha.slice(0, 7)}`
    );

    // Background tasks (non-blocking for faster webhook response):
    // 1. Fetch workflow list and job details, update check run with detailed status
    // 2. Post waiting comment to PR
    const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
    });
    waitUntilTracked([
      {
        task: (async () => {
          // Fetch all workflows for this commit to show detailed status
          const { evaluation } = await github.listWorkflowRunsForCommit(
            token,
            owner,
            repo,
            headSha
          );

          const jobsByRunId = await fetchJobDetailsWithRateLimit(
            github,
            token,
            owner,
            repo,
            evaluation,
            `workflow_run:${checkRun.id}`
          );

          // Update check run with workflow and job visibility
          const { title, summary } = formatWaitingCheckRunOutput({
            evaluation,
            jobsByRunId: jobsByRunId.size > 0 ? jobsByRunId : undefined,
          });
          await github.updateCheckRun(token, {
            owner,
            repo,
            checkRunId: checkRun.id,
            status: "in_progress",
            output: { title, summary },
          });
        })(),
        context: { operation: "update_check_run_status" },
      },
      {
        task: postWaitingComment({
          env: c.env,
          token,
          owner,
          repo,
          repository: repository.full_name,
          prNumber,
          headSha,
          headCommitMessage: workflow_run.head_commit?.message,
          deliveryId,
        }),
        context: { operation: "post_waiting_comment", prNumber },
      },
    ]);

    return c.json({
      message: "check run created",
      checkRunId: checkRun.id,
      status: "queued",
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error creating queued check run [delivery: ${deliveryId}]:`,
      error
    );
    // Non-fatal - we'll create the check run on completed if this fails
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "workflow_run.in_progress",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
      workflowName: workflow_run.name,
      runId: workflow_run.id,
    });
    return c.json({
      message: "failed to create check run",
      errorCode: classified.code,
      error: classified.message,
      hint: classified.hint,
      deliveryId,
      repository: repository.full_name,
    });
  }
};

// ============================================================================
// Handle workflow_run.completed
// ============================================================================
// Waits for ALL workflow runs for a commit to complete before posting comment
//
// Robustness features:
// - Idempotency: Uses KV-backed lock to prevent duplicate processing (survives Worker restarts)
// - Race condition handling: Returns early if another webhook is processing
// - Error recovery: Cleans up check run on failure (retrieves stored ID early)
// - Database-backed deduplication: Unique constraint on (repository, commitSha, runId)
export const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: webhook handler requires sequential orchestration
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
  const headCommitMessage = workflow_run.head_commit?.message;
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
    const status = state?.processing
      ? "duplicate_in_progress"
      : "duplicate_completed";
    console.log(
      `[workflow_run] Commit ${headSha.slice(0, 7)} ${state?.processing ? "already being processed" : "already processed"}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: state?.processing ? "already processing" : "already processed",
      repository: repository.full_name,
      headSha,
      checkRunId: state?.checkRunId,
      status,
    });
  }

  const github = createGitHubService(c.env);
  let checkRunId: number | undefined;
  let token: string | undefined;

  // IMPORTANT: Retrieve stored check run ID early for error recovery
  // This ensures we can clean up the check run if errors occur before we
  // would normally fetch it. Without this, check runs can get stuck as "queued" forever.
  const storedCheckRunIdForRecovery = await getStoredCheckRunId(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );
  if (storedCheckRunIdForRecovery) {
    console.log(
      `[workflow_run] Found stored check run ${storedCheckRunIdForRecovery} for recovery [delivery: ${deliveryId}]`
    );
  }

  try {
    token = await github.getInstallationToken(installation.id);

    // Get PR number (skip if no PR associated)
    // For fork PRs, workflow_run.pull_requests is empty but commits API works
    const prFromPayload = workflow_run.pull_requests[0]?.number;
    const prNumber =
      prFromPayload ??
      (await github.getPullRequestForCommit(token, owner, repo, headSha));

    if (!prNumber) {
      return c.json(
        await handleNoPrEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            runId: workflow_run.id,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
          }
        )
      );
    }

    // Check if ALL workflow runs for this commit are done BEFORE creating check run
    const {
      allCompleted,
      runs: workflowRuns,
      evaluation,
    } = await github.listWorkflowRunsForCommit(token, owner, repo, headSha);

    if (!allCompleted) {
      return c.json(
        await handleWaitingForRunsEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          c.executionCtx,
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
            completedCount:
              evaluation.ciRelevantRuns.length -
              evaluation.pendingCiRuns.length,
            pendingCount: evaluation.pendingCiRuns.length,
            evaluation,
          }
        )
      );
    }

    // Run-aware idempotency: check which specific (runId, runAttempt) tuples exist
    // This enables proper re-run handling - same runId with different runAttempt is a new run
    // Performance: Also loads org settings in same DB connection (with caching)
    const runIdentifiers = workflowRuns.map((r) => ({
      runId: r.id,
      runAttempt: r.runAttempt,
    }));

    const { allExist, existingRuns, orgSettings } =
      await checkRunsAndLoadOrgSettings(
        c.env,
        repository.full_name,
        runIdentifiers,
        installation.id
      );

    if (allExist) {
      return c.json(
        await handleAllRunsProcessedEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
            runCount: runIdentifiers.length,
          }
        )
      );
    }

    // Filter to only runs that need processing (re-runs will pass through)
    const runsToProcess = workflowRuns.filter(
      (r) => !existingRuns.has(`${r.id}:${r.runAttempt}`)
    );

    console.log(
      `[workflow_run] Processing ${runsToProcess.length} new runs (${existingRuns.size} already stored)`
    );

    // All runs completed! Get or create check run
    // Use the check run ID we retrieved early for error recovery
    if (storedCheckRunIdForRecovery) {
      // Update existing check run to in_progress
      checkRunId = storedCheckRunIdForRecovery;
      await github.updateCheckRun(token, {
        owner,
        repo,
        checkRunId,
        status: "in_progress",
        output: {
          title: "Analyzing CI results...",
          summary: "Processing workflow runs and extracting errors",
        },
      });
      console.log(
        `[workflow_run] Updated existing check run ${checkRunId} to in_progress`
      );
    } else {
      // No existing check run - create one (fallback if in_progress handler didn't run)
      const checkRun = await github.createCheckRun(token, {
        owner,
        repo,
        headSha,
        name: "Detent Heal",
        status: "in_progress",
        output: {
          title: "Analyzing CI results...",
          summary: "Processing workflow runs and extracting errors",
        },
      });
      checkRunId = checkRun.id;
      console.log(`[workflow_run] Created new check run ${checkRunId}`);
    }

    // At this point checkRunId is guaranteed to be set
    const finalCheckRunId = checkRunId;

    // Check if job already reported errors via POST /report
    const jobReportedErrors = await checkForJobReportedErrors(
      c.env,
      repository.full_name,
      runsToProcess
    );

    // Check for failed workflows
    const failedRuns = runsToProcess.filter((r) => r.conclusion === "failure");
    const failedRunCount = failedRuns.length;
    const hasFailed = failedRunCount > 0;

    // Collect errors from job-reported errors only (no fallback log-parsing)
    const allErrors: ParsedError[] = jobReportedErrors ?? [];

    if (jobReportedErrors) {
      console.log(
        `[workflow_run] Found ${jobReportedErrors.length} job-reported errors`
      );
    }

    // If workflows failed but no errors reported, show warning
    if (hasFailed && allErrors.length === 0) {
      console.log(
        `[workflow_run] ${failedRunCount} failed runs but no errors found`
      );

      // Update check run with warning
      await github.updateCheckRun(token, {
        owner,
        repo,
        checkRunId: finalCheckRunId,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "No errors found to heal",
          summary:
            "Workflow failed but no errors were reported. Ensure the Detent action is configured in your workflow.",
        },
      });

      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );

      return c.json({
        message: "workflow_run processed - no errors found",
        repository: repository.full_name,
        prNumber,
        runsProcessed: runsToProcess.length,
        failedRuns: failedRunCount,
        totalErrors: 0,
        checkRunId: finalCheckRunId,
        warning: "action_not_configured",
      });
    }

    // Trigger autofix orchestration for fixable errors
    // Run synchronously so we can return autofix configs for the action to execute
    let autofixes: Array<{ healId: string; source: string; command: string }> =
      [];

    if (allErrors.length > 0 && runsToProcess.length > 0) {
      try {
        const { db: healDb, client: healClient } = await createDb(c.env);
        try {
          // Get run database IDs directly from stored runs
          const runIds = runsToProcess.map((r) => r.id.toString());
          const storedRuns = await healDb
            .select({
              id: runs.id,
              projectId: runs.projectId,
            })
            .from(runs)
            .where(inArray(runs.runId, runIds))
            .limit(runIds.length);

          if (storedRuns.length > 0) {
            // Query errors using run database IDs (not GitHub run IDs)
            const runDbIds = storedRuns.map((r) => r.id);
            const storedErrors = await healDb
              .select({
                id: runErrors.id,
                source: runErrors.source,
                signatureId: runErrors.signatureId,
                fixable: runErrors.fixable,
              })
              .from(runErrors)
              .where(inArray(runErrors.runId, runDbIds));

            // Only orchestrate if we have fixable errors
            if (storedErrors.some((e) => e.fixable)) {
              const firstStoredRun = storedRuns[0];
              const firstRunToProcess = runsToProcess[0];

              if (firstStoredRun?.projectId && firstRunToProcess) {
                const result = await orchestrateHeals({
                  env: c.env,
                  projectId: firstStoredRun.projectId,
                  runId: firstStoredRun.id,
                  commitSha: headSha,
                  prNumber,
                  branch: workflow_run.head_branch ?? "main",
                  repoFullName: repository.full_name,
                  installationId: installation.id,
                  errors: storedErrors.map((e) => ({
                    id: e.id,
                    source: e.source ?? undefined,
                    signatureId: e.signatureId ?? undefined,
                    fixable: e.fixable ?? false,
                  })),
                  orgSettings,
                });

                autofixes = result.autofixes;

                if (result.healsCreated > 0) {
                  console.log(
                    `[workflow_run] Orchestrated ${result.healsCreated} heals for ${repository.full_name}#${prNumber}`
                  );
                }

                // Log partial failures if any
                if (result.partialFailures.length > 0) {
                  console.warn(
                    `[workflow_run] ${result.partialFailures.length} heal orchestration failures:`,
                    result.partialFailures
                  );
                }
              }
            }
          } else {
            console.log(
              "[workflow_run] No stored runs found for heal orchestration"
            );
          }
        } finally {
          await healClient.end();
        }
      } catch (error) {
        // Non-fatal: Don't fail the webhook if heal orchestration fails
        console.error("[workflow_run] Heal orchestration error:", error);
      }
    }

    // Finalize: update check run and post PR comment (if failures)
    const { totalErrors } = await finalizeAndPostResults(
      c.env,
      github,
      token,
      c.env["detent-idempotency"],
      {
        owner,
        repo,
        repository: repository.full_name,
        executionCtx: c.executionCtx,
        headSha,
        headCommitMessage,
        prNumber,
        checkRunId: finalCheckRunId,
        workflowRuns,
        allErrors,
        detectedUnsupportedTools: [],
        enableInlineAnnotations: orgSettings.enableInlineAnnotations,
        enablePrComments: orgSettings.enablePrComments,
        ciRelevantRunCount: evaluation.ciRelevantRuns.length,
        deliveryId,
      }
    );

    // Release lock after successful processing
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
      failedRuns: failedRunCount,
      totalErrors,
      checkRunId: finalCheckRunId,
      autofixes,
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error processing [delivery: ${deliveryId}]:`,
      error
    );

    // Error recovery: Clean up check run if we have one
    // Use storedCheckRunIdForRecovery as fallback if checkRunId wasn't set yet
    const checkRunToCleanup = checkRunId ?? storedCheckRunIdForRecovery;
    if (checkRunToCleanup) {
      await attemptCheckRunCleanup(
        github,
        token,
        installation.id,
        owner,
        repo,
        checkRunToCleanup,
        deliveryId,
        error
      );
    }

    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "workflow_run",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
      workflowName: workflow_run.name,
      runId: workflow_run.id,
    });
    return c.json(
      {
        message: "workflow_run error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};
