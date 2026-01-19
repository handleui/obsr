import { sleep } from "../../../lib/async";
import { captureWebhookError } from "../../../lib/sentry";
import { formatWaitingCheckRunOutput } from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import {
  getStoredCheckRunId,
  storeCheckRunId,
} from "../../../services/idempotency";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { CheckSuitePayload, WebhookContext } from "../types";
import { fetchJobDetailsWithRateLimit } from "../utils/job-fetcher";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";
import { postWaitingComment } from "../waiting-comment";

// Delay before fetching workflows to allow GitHub to start them
// Workflows may not be visible immediately after check_suite.requested fires
const WORKFLOW_VISIBILITY_DELAY_MS = 3000;

// Handle check_suite.requested - create a "queued" check run immediately
//
// Performance optimization (Cloudflare Workers):
// - Creates check run immediately with minimal output (fast response to GitHub)
// - Fetches workflow list in background via waitUntil (non-blocking)
// - Updates check run with detailed workflow status asynchronously
export const handleCheckSuiteRequested = async (
  c: WebhookContext,
  payload: CheckSuitePayload
) => {
  const { action, check_suite, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only handle "requested" action
  if (action !== "requested") {
    return c.json({ message: "ignored", action });
  }

  // Skip if no PR associated (e.g., push to main branch)
  if (check_suite.pull_requests.length === 0) {
    console.log(
      `[check_suite] No PR associated with ${check_suite.head_sha.slice(0, 7)}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: "skipped",
      reason: "no_pr",
      branch: check_suite.head_branch,
    });
  }

  const headSha = check_suite.head_sha;
  const firstPr = check_suite.pull_requests[0];
  if (!firstPr) {
    // Should never happen after length check, but satisfy TypeScript
    return c.json({ message: "skipped", reason: "no_pr" });
  }
  const prNumber = firstPr.number;
  const kv = c.env["detent-idempotency"];

  console.log(
    `[check_suite] Requested: ${repository.full_name} @ ${headSha.slice(0, 7)} (PR #${prNumber}) [delivery: ${deliveryId}]`
  );

  // Check if check run already exists (idempotency)
  const existingCheckRunId = await getStoredCheckRunId(
    kv,
    repository.full_name,
    headSha
  );

  if (existingCheckRunId) {
    console.log(
      `[check_suite] Check run ${existingCheckRunId} already exists for ${headSha.slice(0, 7)}`
    );
    return c.json({
      message: "check run already exists",
      checkRunId: existingCheckRunId,
    });
  }

  const github = createGitHubService(c.env);

  try {
    const token = await github.getInstallationToken(installation.id);
    const owner = repository.owner.login;
    const repo = repository.name;

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

    console.log(
      `[check_suite] Created queued check run ${checkRun.id} for ${headSha.slice(0, 7)}`
    );

    // Fire-and-forget background tasks (non-blocking for faster response)
    // 1. Store check run ID for later retrieval
    // 2. Fetch workflow list and update check run with detailed status
    // 3. Post waiting comment to PR
    const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
    });
    waitUntilTracked([
      {
        // Store check run ID - critical for later updates
        task: storeCheckRunId(kv, repository.full_name, headSha, checkRun.id),
        context: { operation: "store_check_run_id" },
      },
      {
        // Fetch workflow list and job details, update check run with detailed status
        task: (async () => {
          await sleep(WORKFLOW_VISIBILITY_DELAY_MS);
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
            `check_suite:${checkRun.id}`
          );

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
          headCommitMessage: check_suite.head_commit?.message,
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
      `[check_suite] Error creating queued check run [delivery: ${deliveryId}]:`,
      error
    );

    // Return 500 to be consistent with other error handlers in this file
    // The check run will be created when workflow_run.in_progress fires as fallback
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "check_suite",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "failed to create check run",
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
