import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../../../db/client";
import { runErrors, runs } from "../../../db/schema";
import { captureWebhookError, type ParserContext } from "../../../lib/sentry";
import { orchestrateHeals } from "../../../services/autofix/orchestrator";
import {
  formatCheckRunOutput,
  formatResultsComment,
  formatWaitingCheckRunOutput,
} from "../../../services/comment-formatter";
import type { ParsedError } from "../../../services/error-parser";
import { parseWorkflowLogsWithFallback } from "../../../services/error-parser";
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
  bulkStoreRunsAndErrors,
  checkRunsAndLoadOrgSettings,
  prepareRunData,
} from "../../../services/webhooks/db-operations";
import {
  classifyError,
  sanitizeErrorMessage,
} from "../../../services/webhooks/error-classifier";
import type {
  PreparedRunData,
  WorkflowRunMeta,
} from "../../../services/webhooks/types";
import type { Env } from "../../../types/env";
import type { WebhookContext, WorkflowRunPayload } from "../types";
import {
  attemptCheckRunCleanup,
  handleAllRunsProcessedEarlyReturn,
  handleNoPrEarlyReturn,
  handleWaitingForRunsEarlyReturn,
} from "../utils/early-returns";
import { fetchJobDetailsWithRateLimit } from "../utils/job-fetcher";
import { postWaitingComment } from "../waiting-comment";

// ============================================================================
// Workflow Run Processing
// ============================================================================
// Handles workflow_run.in_progress and workflow_run.completed events.
// Architecture:
// - in_progress: Creates a "queued" check run so users see Detent is watching
// - completed: Waits for ALL workflow runs for a commit, then posts analysis

// ============================================================================
// Helper: Process and store all workflow runs
// ============================================================================
// Strategy:
// - Failed runs: fetch logs, parse errors, store with error details
// - Other runs: store with metadata only (no errors)
//
// Performance optimizations (Cloudflare Workers - 128MB memory, 6 TCP connections):
// - Fetches logs in parallel batches (MAX_CONCURRENT_FETCHES) to reduce latency
// - Parses logs immediately after fetch to free memory before next batch
// - BULK INSERTS: All runs stored in single transaction (1 connection, not N)
// - Reduces DB round-trips from 2N to 2 (one INSERT for runs, one for errors)

const processAndStoreAllRuns = async (
  env: Env,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  allRuns: WorkflowRunMeta[],
  context: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    repository: string;
    checkRunId: number;
  }
): Promise<{
  errors: ParsedError[];
  detectedUnsupportedTools: string[];
  parserContext?: ParserContext;
}> => {
  // Limit concurrent fetches to avoid memory pressure from multiple ZIP files
  // Each workflow log can be up to 30MB compressed, so we keep this conservative
  const MAX_CONCURRENT_FETCHES = 3;

  const allErrors: ParsedError[] = [];
  const allUnsupportedTools = new Set<string>();
  const failedRuns = allRuns.filter((r) => r.conclusion === "failure");
  const passingRuns = allRuns.filter((r) => r.conclusion !== "failure");

  // Map to store errors by run ID
  const errorsByRunId = new Map<number, ParsedError[]>();

  // Store passing runs with empty errors (no log fetching needed)
  for (const run of passingRuns) {
    errorsByRunId.set(run.id, []);
  }

  console.log(
    `[workflow_run] Processing ${allRuns.length} runs: ${failedRuns.length} failed (fetching logs), ${passingRuns.length} passed (storing metadata only)`
  );

  // Track aggregated parser context for Sentry error reporting
  let aggregatedLogBytes = 0;
  let aggregatedJobCount = 0;
  let aggregatedErrorCount = 0;
  let parsersAvailable: string[] = [];

  // Process a single failed run: fetch logs, parse, and return errors
  const processFailedRun = async (run: WorkflowRunMeta): Promise<void> => {
    try {
      // Fetch logs from GitHub API
      const logsResult = await github.fetchWorkflowLogs(
        token,
        context.owner,
        context.repo,
        run.id
      );

      // Parse logs and extract errors (with fallback if none found)
      const parseResult = parseWorkflowLogsWithFallback(
        logsResult.logs,
        run.name,
        {
          totalBytes: logsResult.totalBytes,
          jobCount: logsResult.jobCount,
        }
      );

      // Attach workflow context to each error
      const errorsWithContext = parseResult.errors.map((e) => ({
        ...e,
        workflowJob: e.workflowJob ?? run.name,
      }));

      // Collect unsupported tools
      for (const tool of parseResult.detectedUnsupportedTools) {
        allUnsupportedTools.add(tool);
      }

      // Aggregate parser context for Sentry error reporting
      aggregatedLogBytes += parseResult.parserContext.logBytes;
      aggregatedJobCount += parseResult.parserContext.jobCount;
      aggregatedErrorCount += parseResult.parserContext.errorCount;
      if (parsersAvailable.length === 0) {
        parsersAvailable = parseResult.parserContext.parsersAvailable;
      }

      console.log(
        `[workflow_run] Parsed ${errorsWithContext.length} errors from run ${run.id} (${run.name})`
      );

      errorsByRunId.set(run.id, errorsWithContext);
      allErrors.push(...errorsWithContext);
    } catch (error) {
      // If log fetching/parsing fails, use a fallback error
      console.error(
        `[workflow_run] Failed to fetch/parse logs for run ${run.id}:`,
        error
      );

      // Sanitize error message for user-facing output (avoid leaking internal details)
      const sanitizedMessage = sanitizeErrorMessage(error);
      const fallbackError: ParsedError = {
        message: `Workflow "${run.name}" failed. Unable to fetch logs: ${sanitizedMessage}`,
        category: "workflow",
        severity: "error",
        source: "github-actions",
        workflowJob: run.name,
      };

      errorsByRunId.set(run.id, [fallbackError]);
      allErrors.push(fallbackError);
    }
  };

  // Fetch and parse logs for failed runs in parallel batches
  for (let i = 0; i < failedRuns.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = failedRuns.slice(i, i + MAX_CONCURRENT_FETCHES);
    await Promise.all(batch.map(processFailedRun));
  }

  // Prepare all runs for bulk storage (validates and sanitizes data)
  const preparedRuns: PreparedRunData[] = [];
  for (const run of allRuns) {
    const prepared = prepareRunData({
      runId: run.id,
      runName: run.name,
      prNumber: context.prNumber,
      headSha: context.headSha,
      errors: errorsByRunId.get(run.id) ?? [],
      repository: context.repository,
      checkRunId: context.checkRunId,
      conclusion: run.conclusion,
      headBranch: run.headBranch,
      runAttempt: run.runAttempt,
      runStartedAt: run.runStartedAt,
    });
    if (prepared) {
      preparedRuns.push(prepared);
    }
  }

  // Bulk store all runs in a single transaction for efficiency
  await bulkStoreRunsAndErrors(env, preparedRuns);

  // Build aggregated parser context if any runs were successfully parsed
  const parserContext: ParserContext | undefined =
    aggregatedLogBytes > 0
      ? {
          logBytes: aggregatedLogBytes,
          jobCount: aggregatedJobCount,
          errorCount: aggregatedErrorCount,
          parsersAvailable,
          detectedUnsupportedTools: [...allUnsupportedTools].sort(),
        }
      : undefined;

  return {
    errors: allErrors,
    detectedUnsupportedTools: [...allUnsupportedTools].sort(),
    parserContext,
  };
};

// ============================================================================
// Helper: Check for job-reported errors from POST /report
// ============================================================================

const checkForJobReportedErrors = async (
  env: Env,
  repository: string,
  runsToProcess: WorkflowRunMeta[]
): Promise<ParsedError[] | null> => {
  const { db, client } = await createDb(env);
  try {
    const matchingRuns = await db.query.runs.findMany({
      where: and(
        eq(runs.repository, repository),
        inArray(
          runs.runId,
          runsToProcess.map((r) => String(r.id))
        )
      ),
      with: {
        errors: true,
      },
    });

    const jobReportedErrors: (typeof runErrors.$inferSelect)[] = [];
    for (const run of matchingRuns) {
      const jobErrors = run.errors.filter((e) => e.source === "job-report");
      if (jobErrors.length > 0) {
        jobReportedErrors.push(...jobErrors);
      }
    }

    if (jobReportedErrors.length === 0) {
      return null;
    }

    return jobReportedErrors.map((e) => ({
      message: e.message,
      filePath: e.filePath ?? undefined,
      line: e.line ?? undefined,
      column: e.column ?? undefined,
      category: e.category ?? undefined,
      severity: e.severity as "error" | "warning" | undefined,
      ruleId: e.ruleId ?? undefined,
      stackTrace: e.stackTrace ?? undefined,
      workflowJob: e.workflowJob ?? undefined,
      source: e.source ?? undefined,
    }));
  } finally {
    await client.end();
  }
};

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
        console.log(
          `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber}, skipping passing comment update`
        );
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
      console.log(
        `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber}, skipping comment`
      );
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
        c.executionCtx.waitUntil(
          postWaitingComment({
            env: c.env,
            token,
            owner,
            repo,
            repository: repository.full_name,
            prNumber,
            headSha,
            headCommitMessage: workflow_run.head_commit?.message,
          })
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
      name: "Detent Parser",
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
    c.executionCtx.waitUntil(
      Promise.all([
        (async () => {
          try {
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
          } catch (error) {
            // Non-fatal: check run was created, just missing detailed status
            console.error(
              `[workflow_run] Background update failed for check run ${checkRun.id}:`,
              error
            );
          }
        })(),
        postWaitingComment({
          env: c.env,
          token,
          owner,
          repo,
          repository: repository.full_name,
          prNumber,
          headSha,
          headCommitMessage: workflow_run.head_commit?.message,
        }),
      ])
    );

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
  let parserContext: ParserContext | undefined;

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
        name: "Detent Parser",
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

    if (jobReportedErrors) {
      console.log(
        `[workflow_run] Found ${jobReportedErrors.length} job-reported errors, skipping log parsing`
      );

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
          allErrors: jobReportedErrors,
          detectedUnsupportedTools: [],
          enableInlineAnnotations: orgSettings.enableInlineAnnotations,
          enablePrComments: orgSettings.enablePrComments,
          ciRelevantRunCount: evaluation.ciRelevantRuns.length,
        }
      );

      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );

      return c.json({
        message: "workflow_run processed via job-report",
        repository: repository.full_name,
        prNumber,
        source: "job-report",
        totalErrors,
        checkRunId: finalCheckRunId,
      });
    }
    // Process only NEW runs: fetch logs for failures, store with metadata
    // Re-runs (same runId, different runAttempt) will be in runsToProcess
    const {
      errors: allErrors,
      detectedUnsupportedTools,
      parserContext: processedParserContext,
    } = await processAndStoreAllRuns(c.env, github, token, runsToProcess, {
      owner,
      repo,
      prNumber,
      headSha,
      repository: repository.full_name,
      checkRunId: finalCheckRunId,
    });
    parserContext = processedParserContext;

    // Trigger autofix orchestration for fixable errors
    // Run in background to not block webhook response
    c.executionCtx.waitUntil(
      (async () => {
        // Guard: Skip if no new runs to process
        if (runsToProcess.length === 0) {
          return;
        }

        try {
          const { db, client } = await createDb(c.env);
          try {
            // Get run database IDs directly from stored runs
            // More efficient than joining - we know these runs were just stored
            const runIds = runsToProcess.map((r) => r.id.toString());
            const storedRuns = await db
              .select({
                id: runs.id,
                projectId: runs.projectId,
              })
              .from(runs)
              .where(inArray(runs.runId, runIds))
              .limit(runIds.length);

            if (storedRuns.length === 0) {
              console.log(
                "[workflow_run] No stored runs found for heal orchestration"
              );
              return;
            }

            // Query errors using run database IDs (not GitHub run IDs)
            const runDbIds = storedRuns.map((r) => r.id);
            const storedErrors = await db
              .select({
                id: runErrors.id,
                source: runErrors.source,
                signatureId: runErrors.signatureId,
                fixable: runErrors.fixable,
              })
              .from(runErrors)
              .where(inArray(runErrors.runId, runDbIds));

            // Guard: Only orchestrate if we have fixable errors
            if (!storedErrors.some((e) => e.fixable)) {
              return;
            }

            // Guard: Ensure we have the required data
            // Use first stored run's database ID (UUID), not GitHub run ID
            const firstStoredRun = storedRuns[0];
            const firstRunToProcess = runsToProcess[0];
            if (!(firstStoredRun?.projectId && firstRunToProcess)) {
              console.log(
                "[workflow_run] Missing storedRun or firstRunToProcess for heal orchestration"
              );
              return;
            }

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

            if (result.healsCreated > 0) {
              console.log(
                `[workflow_run] Orchestrated ${result.healsCreated} heals for ${repository.full_name}#${prNumber}`
              );
            }
          } finally {
            await client.end();
          }
        } catch (error) {
          // Non-fatal: Don't fail the webhook if heal orchestration fails
          console.error("[workflow_run] Heal orchestration error:", error);
        }
      })()
    );

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
        detectedUnsupportedTools,
        enableInlineAnnotations: orgSettings.enableInlineAnnotations,
        enablePrComments: orgSettings.enablePrComments,
        ciRelevantRunCount: evaluation.ciRelevantRuns.length,
      }
    );

    // Release lock after successful processing (allows future re-runs to acquire)
    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    const failedRunCount = runsToProcess.filter(
      (r) => r.conclusion === "failure"
    ).length;

    return c.json({
      message: "workflow_run processed",
      repository: repository.full_name,
      prNumber,
      runsProcessed: runsToProcess.length,
      failedRuns: failedRunCount,
      totalErrors,
      checkRunId: finalCheckRunId,
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
    captureWebhookError(
      error,
      classified.code,
      {
        eventType: "workflow_run",
        deliveryId,
        repository: repository.full_name,
        installationId: installation.id,
        workflowName: workflow_run.name,
        runId: workflow_run.id,
      },
      parserContext
    );
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
