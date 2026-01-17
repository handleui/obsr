import { captureWebhookError } from "../../../lib/sentry";
import { formatWaitingCheckRunOutput } from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import {
  getStoredCheckRunId,
  storeCheckRunId,
} from "../../../services/idempotency";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { CheckSuitePayload, WebhookContext } from "../types";
import { postWaitingComment } from "../waiting-comment";

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
      name: "Detent Parser",
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
    c.executionCtx.waitUntil(
      Promise.all([
        storeCheckRunId(kv, repository.full_name, headSha, checkRun.id),
        // Fetch workflow list and update check run with detailed status
        (async () => {
          try {
            const { evaluation } = await github.listWorkflowRunsForCommit(
              token,
              owner,
              repo,
              headSha
            );
            const { title, summary } = formatWaitingCheckRunOutput({
              evaluation,
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
              `[check_suite] Background update failed for check run ${checkRun.id}:`,
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
          headCommitMessage: check_suite.head_commit?.message,
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
