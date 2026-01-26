import {
  acquireCommitLock,
  releaseCommitLock,
} from "../../../services/idempotency";
import type { WebhookContext, WorkflowRunPayload } from "../types";

// ============================================================================
// Workflow Run Processing
// ============================================================================
// Observability-only handlers for workflow_run webhooks.
// Comment posting is now handled by the Detent Action via POST /report.

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
// Observability-only: Logs workflow completion for monitoring.
// Comment posting is now handled by the Detent Action via POST /report.
export const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository } = payload;
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

  // Release lock - no further processing needed
  await releaseCommitLock(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );

  return c.json({
    message: "workflow_run logged",
    repository: repository.full_name,
    workflow: workflow_run.name,
    conclusion: workflow_run.conclusion,
  });
};
