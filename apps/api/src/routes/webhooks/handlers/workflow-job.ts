import { getConvexClient } from "../../../db/convex";
import { extractAndStoreErrors } from "../../../services/webhooks/error-extraction";
import { checkAndTriggerAggregation } from "../../../services/webhooks/job-aggregation";
import {
  lookupPrNumberFromRuns,
  updateCommitJobStats,
  upsertJob,
} from "../../../services/webhooks/job-operations";
import {
  isValidCommitSha,
  isValidJobId,
  isValidRepositoryFormat,
  safeLogValue,
} from "../../../services/webhooks/types";
import type { WebhookContext, WorkflowJobPayload } from "../types";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";

interface ValidationError {
  error: string;
  status: 400;
}

const validatePayload = (
  payload: WorkflowJobPayload
): ValidationError | null => {
  const { workflow_job, repository } = payload;

  if (!isValidJobId(workflow_job.id)) {
    console.error(
      `[workflow_job] Invalid job ID: ${safeLogValue(String(workflow_job.id))}`
    );
    return { error: "Invalid job ID", status: 400 };
  }
  if (!isValidCommitSha(workflow_job.head_sha)) {
    console.error(
      `[workflow_job] Invalid commit SHA: ${safeLogValue(workflow_job.head_sha)}`
    );
    return { error: "Invalid commit SHA", status: 400 };
  }
  if (!isValidRepositoryFormat(repository.full_name)) {
    console.error(
      `[workflow_job] Invalid repository format: ${safeLogValue(repository.full_name)}`
    );
    return { error: "Invalid repository format", status: 400 };
  }
  return null;
};

const prepareHandlerContext = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] Processing: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    convex,
    repository.full_name,
    normalizedSha
  );

  return {
    workflow_job,
    repository,
    deliveryId,
    convex,
    normalizedSha,
    prNumber,
  };
};

const buildBaseJobData = (
  ctx: Awaited<ReturnType<typeof prepareHandlerContext>>
) => ({
  providerJobId: String(ctx.workflow_job.id),
  repository: ctx.repository.full_name,
  commitSha: ctx.normalizedSha,
  prNumber: ctx.prNumber,
  name: ctx.workflow_job.name,
  workflowName: ctx.workflow_job.workflow_name,
  htmlUrl: ctx.workflow_job.html_url,
  headBranch: ctx.workflow_job.head_branch,
});

export const handleWorkflowJobQueued = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const ctx = await prepareHandlerContext(c, payload);

  console.log(`[workflow_job] Queued job ${ctx.workflow_job.id}`);

  await Promise.all([
    upsertJob(ctx.convex, {
      ...buildBaseJobData(ctx),
      status: "queued",
      conclusion: null,
      runnerName: null,
      queuedAt: new Date(),
      startedAt: null,
      completedAt: null,
    }),
    updateCommitJobStats(
      ctx.convex,
      ctx.repository.full_name,
      ctx.normalizedSha,
      ctx.prNumber
    ),
  ]);

  return c.json({
    message: "job queued",
    jobId: ctx.workflow_job.id,
    repository: ctx.repository.full_name,
  });
};

export const handleWorkflowJobInProgress = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const ctx = await prepareHandlerContext(c, payload);

  console.log(`[workflow_job] In progress job ${ctx.workflow_job.id}`);

  await Promise.all([
    upsertJob(ctx.convex, {
      ...buildBaseJobData(ctx),
      status: "in_progress",
      conclusion: null,
      runnerName: ctx.workflow_job.runner_name,
      queuedAt: null,
      startedAt: ctx.workflow_job.started_at
        ? new Date(ctx.workflow_job.started_at)
        : new Date(),
      completedAt: null,
    }),
    updateCommitJobStats(
      ctx.convex,
      ctx.repository.full_name,
      ctx.normalizedSha,
      ctx.prNumber
    ),
  ]);

  return c.json({
    message: "job in_progress",
    jobId: ctx.workflow_job.id,
    repository: ctx.repository.full_name,
  });
};

export const handleWorkflowJobCompleted = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const ctx = await prepareHandlerContext(c, payload);
  const conclusion = mapConclusion(ctx.workflow_job.conclusion);

  console.log(
    `[workflow_job] Completed job ${ctx.workflow_job.id} (${ctx.workflow_job.conclusion})`
  );

  await upsertJob(ctx.convex, {
    ...buildBaseJobData(ctx),
    status: "completed",
    conclusion,
    runnerName: ctx.workflow_job.runner_name,
    queuedAt: null,
    startedAt: ctx.workflow_job.started_at
      ? new Date(ctx.workflow_job.started_at)
      : null,
    completedAt: ctx.workflow_job.completed_at
      ? new Date(ctx.workflow_job.completed_at)
      : new Date(),
  });

  if (ctx.workflow_job.conclusion === "failure") {
    const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
      deliveryId: ctx.deliveryId,
      repository: ctx.repository.full_name,
      installationId: payload.installation?.id,
    });
    waitUntilTracked(extractAndStoreErrors(c.env, payload, ctx.convex), {
      operation: "error_extraction",
      runId: ctx.workflow_job.run_id,
    });
  }

  await updateCommitJobStats(
    ctx.convex,
    ctx.repository.full_name,
    ctx.normalizedSha,
    ctx.prNumber
  );

  const aggregation = await checkAndTriggerAggregation(
    c.env,
    ctx.convex,
    ctx.repository.full_name,
    ctx.normalizedSha
  );

  return c.json({
    message: "job completed",
    jobId: ctx.workflow_job.id,
    conclusion: ctx.workflow_job.conclusion,
    repository: ctx.repository.full_name,
    aggregation,
  });
};

export const handleWorkflowJobWaiting = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const ctx = await prepareHandlerContext(c, payload);

  console.log(`[workflow_job] Waiting job ${ctx.workflow_job.id}`);

  await Promise.all([
    upsertJob(ctx.convex, {
      ...buildBaseJobData(ctx),
      status: "waiting",
      conclusion: null,
      runnerName: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
    }),
    updateCommitJobStats(
      ctx.convex,
      ctx.repository.full_name,
      ctx.normalizedSha,
      ctx.prNumber
    ),
  ]);

  return c.json({
    message: "job waiting",
    jobId: ctx.workflow_job.id,
    repository: ctx.repository.full_name,
  });
};

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

const VALID_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
]);

const mapConclusion = (conclusion: string | null): JobConclusion => {
  if (!conclusion) {
    return null;
  }
  return VALID_CONCLUSIONS.has(conclusion)
    ? (conclusion as JobConclusion)
    : null;
};
