import { getConvexClient } from "../../../db/convex";
import { extractAndStoreErrors } from "../../../services/webhooks/error-extraction";
import { checkAndTriggerAggregation } from "../../../services/webhooks/job-aggregation";
import {
  lookupPrNumberFromRuns,
  updateCommitJobStats,
  upsertJob,
} from "../../../services/webhooks/job-operations";
import type { WebhookContext, WorkflowJobPayload } from "../types";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";

// Input Validation
const SHA_REGEX = /^[a-fA-F0-9]{40}$/;
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
const MAX_JOB_ID = Number.MAX_SAFE_INTEGER;

const isValidCommitSha = (sha: string): boolean => SHA_REGEX.test(sha);

const isValidJobId = (id: number): boolean =>
  Number.isInteger(id) && id > 0 && id <= MAX_JOB_ID;

const isValidRepositoryFormat = (repo: string): boolean => {
  const parts = repo.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [owner, name] = parts;
  return (
    !!owner &&
    !!name &&
    owner.length <= 39 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(owner) &&
    GITHUB_NAME_PATTERN.test(name) &&
    !owner.includes("..") &&
    !name.includes("..")
  );
};

const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

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

export const handleWorkflowJobQueued = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] Queued: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    convex,
    repository.full_name,
    normalizedSha
  );

  await Promise.all([
    upsertJob(convex, {
      providerJobId: String(workflow_job.id),
      repository: repository.full_name,
      commitSha: normalizedSha,
      prNumber,
      name: workflow_job.name,
      workflowName: workflow_job.workflow_name,
      status: "queued",
      conclusion: null,
      htmlUrl: workflow_job.html_url,
      runnerName: null,
      headBranch: workflow_job.head_branch,
      queuedAt: new Date(),
      startedAt: null,
      completedAt: null,
    }),
    updateCommitJobStats(convex, repository.full_name, normalizedSha, prNumber),
  ]);

  return c.json({
    message: "job queued",
    jobId: workflow_job.id,
    repository: repository.full_name,
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

  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] In progress: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    convex,
    repository.full_name,
    normalizedSha
  );

  await Promise.all([
    upsertJob(convex, {
      providerJobId: String(workflow_job.id),
      repository: repository.full_name,
      commitSha: normalizedSha,
      prNumber,
      name: workflow_job.name,
      workflowName: workflow_job.workflow_name,
      status: "in_progress",
      conclusion: null,
      htmlUrl: workflow_job.html_url,
      runnerName: workflow_job.runner_name,
      headBranch: workflow_job.head_branch,
      queuedAt: null,
      startedAt: workflow_job.started_at
        ? new Date(workflow_job.started_at)
        : new Date(),
      completedAt: null,
    }),
    updateCommitJobStats(convex, repository.full_name, normalizedSha, prNumber),
  ]);

  return c.json({
    message: "job in_progress",
    jobId: workflow_job.id,
    repository: repository.full_name,
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

  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] Completed: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (${workflow_job.conclusion}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const conclusion = mapConclusion(workflow_job.conclusion);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    convex,
    repository.full_name,
    normalizedSha
  );

  await upsertJob(convex, {
    providerJobId: String(workflow_job.id),
    repository: repository.full_name,
    commitSha: normalizedSha,
    prNumber,
    name: workflow_job.name,
    workflowName: workflow_job.workflow_name,
    status: "completed",
    conclusion,
    htmlUrl: workflow_job.html_url,
    runnerName: workflow_job.runner_name,
    headBranch: workflow_job.head_branch,
    queuedAt: null,
    startedAt: workflow_job.started_at
      ? new Date(workflow_job.started_at)
      : null,
    completedAt: workflow_job.completed_at
      ? new Date(workflow_job.completed_at)
      : new Date(),
  });

  if (workflow_job.conclusion === "failure") {
    const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
      deliveryId,
      repository: repository.full_name,
      installationId: payload.installation?.id,
    });
    waitUntilTracked(extractAndStoreErrors(c.env, payload, convex), {
      operation: "error_extraction",
      runId: workflow_job.run_id,
    });
  }

  await updateCommitJobStats(
    convex,
    repository.full_name,
    normalizedSha,
    prNumber
  );

  const aggregation = await checkAndTriggerAggregation(
    c.env,
    convex,
    repository.full_name,
    normalizedSha
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
  const validationError = validatePayload(payload);
  if (validationError) {
    return c.json({ error: validationError.error }, 400);
  }

  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_job] Waiting: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();
  const prNumber = await lookupPrNumberFromRuns(
    convex,
    repository.full_name,
    normalizedSha
  );

  await Promise.all([
    upsertJob(convex, {
      providerJobId: String(workflow_job.id),
      repository: repository.full_name,
      commitSha: normalizedSha,
      prNumber,
      name: workflow_job.name,
      workflowName: workflow_job.workflow_name,
      status: "waiting",
      conclusion: null,
      htmlUrl: workflow_job.html_url,
      runnerName: null,
      headBranch: workflow_job.head_branch,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
    }),
    updateCommitJobStats(convex, repository.full_name, normalizedSha, prNumber),
  ]);

  return c.json({
    message: "job waiting",
    jobId: workflow_job.id,
    repository: repository.full_name,
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

const mapConclusion = (conclusion: string | null): JobConclusion => {
  if (!conclusion) {
    return null;
  }
  const valid = [
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
    "stale",
    "startup_failure",
  ];
  return valid.includes(conclusion) ? (conclusion as JobConclusion) : null;
};
