import { getConvexClient } from "../../../db/convex";
import { extractAndStoreErrors } from "../../../services/webhooks/error-extraction";
import { checkAndTriggerAggregation } from "../../../services/webhooks/job-aggregation";
import type { UpsertJobData } from "../../../services/webhooks/job-operations";
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

interface JobHandlerContext {
  c: WebhookContext;
  payload: WorkflowJobPayload;
  normalizedSha: string;
  prNumber: number | undefined;
  db: ReturnType<typeof getConvexClient>;
  deliveryId: string;
}

const prepareJobHandler = async (
  c: WebhookContext,
  payload: WorkflowJobPayload,
  label: string
): Promise<JobHandlerContext | Response> => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] ${label}: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const db = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    db,
    repository.full_name,
    normalizedSha
  );

  return { c, payload, normalizedSha, prNumber, db, deliveryId };
};

const isResponse = (value: JobHandlerContext | Response): value is Response =>
  value instanceof Response;

const buildBaseJobData = (
  ctx: JobHandlerContext,
  overrides: Pick<
    UpsertJobData,
    | "status"
    | "conclusion"
    | "runnerName"
    | "queuedAt"
    | "startedAt"
    | "completedAt"
  >
): UpsertJobData => {
  const { payload, normalizedSha, prNumber } = ctx;
  const { workflow_job, repository } = payload;
  return {
    providerJobId: String(workflow_job.id),
    repository: repository.full_name,
    commitSha: normalizedSha,
    prNumber,
    name: workflow_job.name,
    workflowName: workflow_job.workflow_name,
    htmlUrl: workflow_job.html_url,
    headBranch: workflow_job.head_branch,
    ...overrides,
  };
};

const upsertAndUpdateStats = async (
  ctx: JobHandlerContext,
  jobData: UpsertJobData
): Promise<void> => {
  await Promise.all([
    upsertJob(ctx.db, jobData),
    updateCommitJobStats(
      ctx.db,
      jobData.repository,
      ctx.normalizedSha,
      ctx.prNumber
    ),
  ]);
};

export const handleWorkflowJobQueued = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const result = await prepareJobHandler(c, payload, "Queued");
  if (isResponse(result)) {
    return result;
  }

  const jobData = buildBaseJobData(result, {
    status: "queued",
    conclusion: null,
    runnerName: null,
    queuedAt: new Date(),
    startedAt: null,
    completedAt: null,
  });

  await upsertAndUpdateStats(result, jobData);

  return c.json({
    message: "job queued",
    jobId: payload.workflow_job.id,
    repository: payload.repository.full_name,
  });
};

export const handleWorkflowJobInProgress = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const result = await prepareJobHandler(c, payload, "In progress");
  if (isResponse(result)) {
    return result;
  }

  const { workflow_job } = payload;
  const jobData = buildBaseJobData(result, {
    status: "in_progress",
    conclusion: null,
    runnerName: workflow_job.runner_name,
    queuedAt: null,
    startedAt: workflow_job.started_at
      ? new Date(workflow_job.started_at)
      : new Date(),
    completedAt: null,
  });

  await upsertAndUpdateStats(result, jobData);

  return c.json({
    message: "job in_progress",
    jobId: workflow_job.id,
    repository: payload.repository.full_name,
  });
};

export const handleWorkflowJobCompleted = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const result = await prepareJobHandler(c, payload, "Completed");
  if (isResponse(result)) {
    return result;
  }

  const { workflow_job, repository } = payload;
  const jobData = buildBaseJobData(result, {
    status: "completed",
    conclusion: mapConclusion(workflow_job.conclusion),
    runnerName: workflow_job.runner_name,
    queuedAt: null,
    startedAt: workflow_job.started_at
      ? new Date(workflow_job.started_at)
      : null,
    completedAt: workflow_job.completed_at
      ? new Date(workflow_job.completed_at)
      : new Date(),
  });

  await upsertJob(result.db, jobData);

  if (workflow_job.conclusion === "failure") {
    const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
      deliveryId: result.deliveryId,
      repository: repository.full_name,
      installationId: payload.installation?.id,
    });
    waitUntilTracked(extractAndStoreErrors(c.env, payload, result.db), {
      operation: "error_extraction",
      runId: workflow_job.run_id,
    });
  }

  await updateCommitJobStats(
    result.db,
    repository.full_name,
    result.normalizedSha,
    result.prNumber
  );

  const aggregation = await checkAndTriggerAggregation(
    c.env,
    result.db,
    repository.full_name,
    result.normalizedSha
  );

  return c.json({
    message: "job completed",
    jobId: workflow_job.id,
    conclusion: workflow_job.conclusion,
    repository: repository.full_name,
    aggregation,
  });
};

export const handleWorkflowJobWaiting = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const result = await prepareJobHandler(c, payload, "Waiting");
  if (isResponse(result)) {
    return result;
  }

  const jobData = buildBaseJobData(result, {
    status: "waiting",
    conclusion: null,
    runnerName: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
  });

  await upsertAndUpdateStats(result, jobData);

  return c.json({
    message: "job waiting",
    jobId: payload.workflow_job.id,
    repository: payload.repository.full_name,
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
