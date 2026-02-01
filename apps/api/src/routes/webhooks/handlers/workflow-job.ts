import { getConvexClient } from "../../../db/convex";
import { checkAndTriggerAggregation } from "../../../services/webhooks/job-aggregation";
import {
  lookupPrNumberFromRuns,
  updateCommitJobStats,
  upsertJob,
} from "../../../services/webhooks/job-operations";
import type { WebhookContext, WorkflowJobPayload } from "../types";

// ============================================================================
// Workflow Job Processing
// ============================================================================
// Handles workflow_job webhook events for full CI job visibility.
// Tracks ALL jobs (not just Detent-enabled ones) for dashboard display.
// Jobs are marked hasDetent=true when POST /report is received from that job.

// ============================================================================
// Input Validation (defense-in-depth for webhook payloads)
// ============================================================================
// SHA validation regex (40 hex characters)
const SHA_REGEX = /^[a-fA-F0-9]{40}$/;

// GitHub name validation pattern (owner/repo segments)
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;

// Maximum safe integer for GitHub job IDs (64-bit but JS safe integer is 53-bit)
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
    owner.length <= 39 && // GitHub max username length
    name.length <= 100 && // GitHub max repo name length
    GITHUB_NAME_PATTERN.test(owner) &&
    GITHUB_NAME_PATTERN.test(name) &&
    !owner.includes("..") &&
    !name.includes("..")
  );
};

// Truncate strings in logs to prevent log injection
const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

// ============================================================================
// Handle workflow_job.queued
// ============================================================================
// Job added to queue - create initial record
export const handleWorkflowJobQueued = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // SECURITY: Validate input before processing
  if (!isValidJobId(workflow_job.id)) {
    console.error(
      `[workflow_job] Invalid job ID: ${safeLogValue(String(workflow_job.id))}`
    );
    return c.json({ error: "Invalid job ID" }, 400);
  }
  if (!isValidCommitSha(workflow_job.head_sha)) {
    console.error(
      `[workflow_job] Invalid commit SHA: ${safeLogValue(workflow_job.head_sha)}`
    );
    return c.json({ error: "Invalid commit SHA" }, 400);
  }
  if (!isValidRepositoryFormat(repository.full_name)) {
    console.error(
      `[workflow_job] Invalid repository format: ${safeLogValue(repository.full_name)}`
    );
    return c.json({ error: "Invalid repository format" }, 400);
  }

  console.log(
    `[workflow_job] Queued: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();

  // Look up PR number from runs table since workflow_job webhook doesn't include it
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
    status: "queued",
    conclusion: null,
    htmlUrl: workflow_job.html_url,
    runnerName: null,
    headBranch: workflow_job.head_branch,
    queuedAt: new Date(),
    startedAt: null,
    completedAt: null,
  });

  await updateCommitJobStats(
    convex,
    repository.full_name,
    normalizedSha,
    prNumber
  );

  return c.json({
    message: "job queued",
    jobId: workflow_job.id,
    repository: repository.full_name,
  });
};

// ============================================================================
// Handle workflow_job.in_progress
// ============================================================================
// Job started running - update status and timing
export const handleWorkflowJobInProgress = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // SECURITY: Validate input before processing
  if (!isValidJobId(workflow_job.id)) {
    console.error(
      `[workflow_job] Invalid job ID: ${safeLogValue(String(workflow_job.id))}`
    );
    return c.json({ error: "Invalid job ID" }, 400);
  }
  if (!isValidCommitSha(workflow_job.head_sha)) {
    console.error(
      `[workflow_job] Invalid commit SHA: ${safeLogValue(workflow_job.head_sha)}`
    );
    return c.json({ error: "Invalid commit SHA" }, 400);
  }
  if (!isValidRepositoryFormat(repository.full_name)) {
    console.error(
      `[workflow_job] Invalid repository format: ${safeLogValue(repository.full_name)}`
    );
    return c.json({ error: "Invalid repository format" }, 400);
  }

  console.log(
    `[workflow_job] In progress: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();

  // Look up PR number from runs table since workflow_job webhook doesn't include it
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
  });

  await updateCommitJobStats(
    convex,
    repository.full_name,
    normalizedSha,
    prNumber
  );

  return c.json({
    message: "job in_progress",
    jobId: workflow_job.id,
    repository: repository.full_name,
  });
};

// ============================================================================
// Handle workflow_job.completed
// ============================================================================
// Job finished - update conclusion, timing, and check aggregation
export const handleWorkflowJobCompleted = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // SECURITY: Validate input before processing
  if (!isValidJobId(workflow_job.id)) {
    console.error(
      `[workflow_job] Invalid job ID: ${safeLogValue(String(workflow_job.id))}`
    );
    return c.json({ error: "Invalid job ID" }, 400);
  }
  if (!isValidCommitSha(workflow_job.head_sha)) {
    console.error(
      `[workflow_job] Invalid commit SHA: ${safeLogValue(workflow_job.head_sha)}`
    );
    return c.json({ error: "Invalid commit SHA" }, 400);
  }
  if (!isValidRepositoryFormat(repository.full_name)) {
    console.error(
      `[workflow_job] Invalid repository format: ${safeLogValue(repository.full_name)}`
    );
    return c.json({ error: "Invalid repository format" }, 400);
  }

  console.log(
    `[workflow_job] Completed: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (${workflow_job.conclusion}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  // Map GitHub conclusion to our enum
  const conclusion = mapConclusion(workflow_job.conclusion);
  const normalizedSha = workflow_job.head_sha.toLowerCase();

  // Look up PR number from runs table since workflow_job webhook doesn't include it
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

  await updateCommitJobStats(
    convex,
    repository.full_name,
    normalizedSha,
    prNumber
  );

  // Check if all jobs for this commit are complete
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

// ============================================================================
// Handle workflow_job.waiting
// ============================================================================
// Job waiting for environment approval or dependencies
export const handleWorkflowJobWaiting = async (
  c: WebhookContext,
  payload: WorkflowJobPayload
) => {
  const { workflow_job, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // SECURITY: Validate input before processing
  if (!isValidJobId(workflow_job.id)) {
    console.error(
      `[workflow_job] Invalid job ID: ${safeLogValue(String(workflow_job.id))}`
    );
    return c.json({ error: "Invalid job ID" }, 400);
  }
  if (!isValidCommitSha(workflow_job.head_sha)) {
    console.error(
      `[workflow_job] Invalid commit SHA: ${safeLogValue(workflow_job.head_sha)}`
    );
    return c.json({ error: "Invalid commit SHA" }, 400);
  }
  if (!isValidRepositoryFormat(repository.full_name)) {
    console.error(
      `[workflow_job] Invalid repository format: ${safeLogValue(repository.full_name)}`
    );
    return c.json({ error: "Invalid repository format" }, 400);
  }

  console.log(
    `[workflow_job] Waiting: ${safeLogValue(repository.full_name)} / ${safeLogValue(workflow_job.name)} (job ${workflow_job.id}) [delivery: ${safeLogValue(deliveryId)}]`
  );

  const convex = getConvexClient(c.env);
  const normalizedSha = workflow_job.head_sha.toLowerCase();

  // Look up PR number from runs table since workflow_job webhook doesn't include it
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
    status: "waiting",
    conclusion: null,
    htmlUrl: workflow_job.html_url,
    runnerName: null,
    headBranch: workflow_job.head_branch,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
  });

  await updateCommitJobStats(
    convex,
    repository.full_name,
    normalizedSha,
    prNumber
  );

  return c.json({
    message: "job waiting",
    jobId: workflow_job.id,
    repository: repository.full_name,
  });
};

// ============================================================================
// Helpers
// ============================================================================

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
