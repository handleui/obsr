import {
  acquireCommitLock,
  releaseCommitLock,
} from "../../../services/idempotency";
import type { WebhookContext, WorkflowRunPayload } from "../types";

const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

// biome-ignore lint/suspicious/useAwait: async required for webhook handler type signature
export const handleWorkflowRunInProgress = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] In progress: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_run.name)} [delivery: ${safeLogValue(deliveryId)}]`
  );

  return c.json({
    message: "skipped",
    reason: "automatic_check_runs_disabled",
  });
};

export const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository } = payload;
  const headSha = workflow_run.head_sha;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] Completed: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_run.name)} (${safeLogValue(workflow_run.conclusion ?? "null")}) [delivery: ${safeLogValue(deliveryId)}]`
  );

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
