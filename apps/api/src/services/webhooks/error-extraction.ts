import { extractErrors } from "@detent/extract";
import type { CIError, HealCreateStatus } from "@detent/types";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK is designed for namespace import
import * as Sentry from "@sentry/cloudflare";
import { getConvexClient } from "../../db/convex";
import { createHeal, getHealsByPr } from "../../db/operations/heals";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../lib/org-settings";
import type { Env } from "../../types/env";
import { hasAutofix } from "../autofix/registry";
import { canRunHeal } from "../billing";
import { createGitHubService } from "../github";
import {
  MAX_COLUMN_NUMBER,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_FILE_PATH_LENGTH,
  MAX_LINE_NUMBER,
  MAX_STACK_TRACE_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  truncateString,
  validatePositiveInt,
} from "./db-operations";
import type { DbClient } from "./types";

// ============================================================================
// Types
// ============================================================================

interface WebhookPayload {
  installation: { id: number };
  repository: { full_name: string };
  workflow_job: {
    id: number;
    run_id: number;
    name: string;
    head_sha: string;
    head_branch: string | null;
    workflow_name: string | null;
  };
}

interface ExtractionContext {
  repository: string;
  jobId: number;
  runId: number;
  jobName: string;
  commitSha: string;
  headBranch: string;
  workflowName: string;
  installationId: number;
  logCtx: string;
}

interface RunError {
  _id: string;
  fixable?: boolean | null;
  category?: string | null;
  source?: string | null;
  signatureId?: string | null;
  workflowJob?: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = "[error-extraction]";
const EXTRACTION_TIMEOUT_MS = 60_000;
const LOCK_TTL_SECONDS = 300;
// Maximum heals to create per extraction to prevent resource exhaustion
const MAX_HEALS_PER_EXTRACTION = 10;

// ============================================================================
// Context & Validation
// ============================================================================

// SHA validation regex (40 hex characters)
const SHA_REGEX = /^[a-fA-F0-9]{40}$/;

// GitHub name validation pattern (owner/repo segments)
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;

// Maximum safe integer for GitHub job IDs (64-bit but JS safe integer is 53-bit)
const MAX_JOB_ID = Number.MAX_SAFE_INTEGER;

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

// SECURITY: Truncate strings in logs to prevent log injection
const safeLogValue = (value: string, maxLen = 100): string =>
  value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

// SECURITY: Sanitize job name for safe logging/storage (truncate + remove control chars)
// Removes: C0 control chars (U+0000-U+001F), DEL (U+007F), zero-width chars (U+200B-U+200F),
// and line/paragraph separators (U+2028-U+2029) that could cause log injection or parsing issues
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control chars for security
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u2029]/g;

const sanitizeJobName = (name: string): string => {
  const cleaned = name.replace(CONTROL_CHAR_PATTERN, "");
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
};

const buildContext = (payload: WebhookPayload): ExtractionContext | null => {
  const repository = payload.repository.full_name;
  const jobId = payload.workflow_job.id;

  // SECURITY: Validate inputs before processing
  if (!isValidJobId(jobId)) {
    console.error(
      `${LOG_PREFIX} Invalid job ID: ${safeLogValue(String(jobId))}`
    );
    return null;
  }

  if (!isValidRepositoryFormat(repository)) {
    console.error(
      `${LOG_PREFIX} Invalid repository format: ${safeLogValue(repository)}`
    );
    return null;
  }

  const commitSha = payload.workflow_job.head_sha;
  if (!SHA_REGEX.test(commitSha)) {
    console.error(
      `${LOG_PREFIX} Invalid commit SHA: ${safeLogValue(commitSha)}`
    );
    return null;
  }

  return {
    repository,
    jobId,
    runId: payload.workflow_job.run_id,
    jobName: sanitizeJobName(payload.workflow_job.name),
    commitSha: commitSha.toLowerCase(),
    headBranch: payload.workflow_job.head_branch ?? "unknown",
    workflowName: payload.workflow_job.workflow_name ?? "Unknown",
    installationId: payload.installation.id,
    logCtx: `${safeLogValue(repository)}#${jobId}`,
  };
};

/**
 * Attempts to acquire an idempotency lock using atomic put-if-absent pattern.
 *
 * Uses KV metadata comparison to achieve atomicity: we write with a unique
 * request ID, then read back to verify we won the race. This prevents TOCTOU
 * race conditions where two requests could both see no lock and proceed.
 *
 * Note: KV is eventually consistent, so two concurrent requests may both
 * "win" in rare cases. The failure mode is duplicate extraction attempts,
 * not data corruption. This is acceptable because extraction is idempotent -
 * storing the same errors twice is harmless. For truly atomic locks, use
 * Durable Objects.
 */
const acquireLock = async (
  kv: KVNamespace,
  repository: string,
  jobId: number
): Promise<boolean> => {
  const lockKey = `lock:extract:${repository}:${jobId}`;
  const requestId = crypto.randomUUID();

  // Check if lock already exists
  const existing = await kv.get(lockKey);
  if (existing) {
    return false;
  }

  // Try to acquire by writing with our request ID
  await kv.put(lockKey, requestId, { expirationTtl: LOCK_TTL_SECONDS });

  // Read back to verify we won the race (handles concurrent writers)
  const written = await kv.get(lockKey);

  // If our request ID is there, we won. If different, another request won.
  return written === requestId;
};

// ============================================================================
// Log Fetching
// ============================================================================

interface FetchLogsResult {
  logs: string | null;
  error?: string;
}

const fetchLogs = async (
  env: Env,
  ctx: ExtractionContext
): Promise<FetchLogsResult> => {
  const github = createGitHubService(env);

  let token: string;
  try {
    token = await github.getInstallationToken(ctx.installationId);
  } catch (error) {
    return {
      logs: null,
      error: `Failed to get token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const [owner, repo] = ctx.repository.split("/");
  if (!(owner && repo)) {
    return { logs: null, error: "Invalid repository format" };
  }

  try {
    const result = await github.fetchWorkflowLogs(
      token,
      owner,
      repo,
      ctx.runId
    );
    return { logs: result.logs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404") || message.includes("expired")) {
      return { logs: null }; // Expected for old runs, no error
    }
    return { logs: null, error: `Failed to fetch logs: ${message}` };
  }
};

// ============================================================================
// AI Extraction
// ============================================================================

interface ExtractResult {
  errors: CIError[];
  truncated: boolean;
}

const runExtraction = async (
  env: Env,
  logContent: string
): Promise<ExtractResult | null> => {
  try {
    const result = await extractErrors(logContent, {
      timeout: EXTRACTION_TIMEOUT_MS,
      apiKey: env.AI_GATEWAY_API_KEY,
    });
    return { errors: result.errors, truncated: result.truncated ?? false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("timed out")) {
      console.warn(`${LOG_PREFIX} AI extraction timed out`);
    } else {
      console.error(`${LOG_PREFIX} AI extraction failed: ${message}`);
    }
    return null;
  }
};

// ============================================================================
// Error Mapping & Storage
// ============================================================================

const mapExtractedToRow = (e: CIError, runId: string, job: string) => ({
  runId,
  // SECURITY: Truncate fields to prevent database bloat from malicious input
  message:
    truncateString(e.message, MAX_ERROR_MESSAGE_LENGTH) ?? "Unknown error",
  filePath: truncateString(e.filePath, MAX_FILE_PATH_LENGTH),
  line: validatePositiveInt(e.line, MAX_LINE_NUMBER),
  column: validatePositiveInt(e.column, MAX_COLUMN_NUMBER),
  severity: truncateString(e.severity, 50) ?? "error",
  ruleId: truncateString(e.ruleId, 200),
  stackTrace: truncateString(e.stackTrace, MAX_STACK_TRACE_LENGTH),
  workflowJob: truncateString(job, MAX_WORKFLOW_NAME_LENGTH) ?? "Unknown",
  source: "webhook-extraction",
  fixable: e.fixable ?? null,
  hints: e.hints ?? null,
  createdAt: Date.now(),
});

const storeErrors = async (
  env: Env,
  ctx: ExtractionContext,
  project: { _id: string },
  errors: CIError[],
  prNumber: number | undefined
): Promise<string | null> => {
  const runRecordId = crypto.randomUUID();
  const convex = getConvexClient(env);
  const errorRows = errors.map((e) =>
    mapExtractedToRow(e, runRecordId, ctx.jobName)
  );

  try {
    await convex.mutation("run_ingest:storeJobReport", {
      run: {
        id: runRecordId,
        projectId: project._id,
        provider: "github",
        source: "webhook-extraction",
        runId: String(ctx.runId),
        repository: ctx.repository,
        commitSha: ctx.commitSha,
        headBranch: ctx.headBranch,
        prNumber,
        workflowName: ctx.workflowName,
        runAttempt: 1,
        errorCount: errors.length,
        conclusion: "failure",
        receivedAt: Date.now(),
      },
      errors: errorRows,
      workflowJob: ctx.jobName,
      source: "webhook-extraction",
    });
    return runRecordId;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ${ctx.logCtx}: Failed to store:`,
      error instanceof Error ? error.message : String(error)
    );
    Sentry.captureMessage("Failed to store extracted errors", {
      level: "error",
      extra: {
        repository: ctx.repository,
        errorCount: errors.length,
        runId: ctx.runId,
        jobName: ctx.jobName,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
};

// ============================================================================
// Heal Creation
// ============================================================================

const isErrorAutofixable = (error: {
  fixable?: boolean | null;
  source?: string | null;
}): boolean => {
  if (error.fixable !== true) {
    return false;
  }
  const source = typeof error.source === "string" ? error.source : "";
  return source.length > 0 && hasAutofix(source);
};

const groupErrorsByWorkflowJob = (
  runErrors: RunError[]
): Map<string, RunError[]> => {
  const groups = new Map<string, RunError[]>();
  for (const error of runErrors) {
    if (typeof error.workflowJob !== "string" || !error.workflowJob) {
      continue;
    }
    if (isErrorAutofixable(error)) {
      continue;
    }
    const existing = groups.get(error.workflowJob) ?? [];
    existing.push(error);
    groups.set(error.workflowJob, existing);
  }
  return groups;
};

const createHealsForErrors = async (
  env: Env,
  convex: DbClient,
  project: { _id: string; organizationId: string },
  runRecordId: string,
  commitSha: string,
  prNumber: number | undefined,
  runErrors: RunError[]
): Promise<void> => {
  if (runErrors.length === 0) {
    return;
  }

  // Parallelize independent queries: org settings and PR heals
  // Note: getHealsByRunId is omitted since runRecordId was just created - it would always be empty
  const [organization, healsByPr] = await Promise.all([
    convex.query("organizations:getById", {
      id: project.organizationId,
    }) as Promise<{ settings?: OrganizationSettings | null } | null>,
    prNumber ? getHealsByPr(env, project._id, prNumber) : Promise.resolve([]),
  ]);

  const orgSettings = getOrgSettings(organization?.settings);

  const existingErrorIds = new Set(
    healsByPr.filter((h) => h.type === "heal").flatMap((h) => h.errorIds ?? [])
  );

  const errorsByJob = groupErrorsByWorkflowJob(runErrors);

  let healStatus: HealCreateStatus = "found";
  if (orgSettings.healAutoTrigger) {
    const billing = await canRunHeal(env, project.organizationId);
    if (billing.allowed) {
      healStatus = "pending";
    }
  }

  const promises: Promise<string>[] = [];
  for (const errors of errorsByJob.values()) {
    // Resource exhaustion protection: limit heals per extraction
    if (promises.length >= MAX_HEALS_PER_EXTRACTION) {
      console.warn(
        `${LOG_PREFIX} Hit max heals limit (${MAX_HEALS_PER_EXTRACTION}), skipping remaining jobs`
      );
      break;
    }

    const errorIds = errors.map((e) => e._id);
    if (errorIds.length === 0) {
      continue;
    }
    if (errorIds.some((id) => existingErrorIds.has(id))) {
      continue;
    }

    const signatureIds = errors
      .map((e) => e.signatureId)
      .filter((id): id is string => typeof id === "string");

    promises.push(
      createHeal(env, {
        type: "heal",
        status: healStatus,
        projectId: project._id,
        runId: runRecordId,
        commitSha,
        prNumber,
        errorIds,
        signatureIds,
      })
    );
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    console.log(`${LOG_PREFIX} Created ${promises.length} heal(s)`);
  }
};

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract errors from workflow logs and store them.
 * Called from webhook handler when a job completes with failure.
 * Non-critical background task - failures are logged but not thrown.
 */
export const extractAndStoreErrors = async (
  env: Env,
  payload: WebhookPayload,
  db: DbClient
): Promise<void> => {
  const ctx = buildContext(payload);

  // SECURITY: Skip processing if input validation failed
  if (!ctx) {
    return;
  }

  // Idempotency check
  const lockAcquired = await acquireLock(
    env["detent-idempotency"],
    ctx.repository,
    ctx.jobId
  );
  if (!lockAcquired) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Already processing, skipping`);
    return;
  }

  // Look up project
  const project = (await db.query("projects:getByRepoFullName", {
    providerRepoFullName: ctx.repository,
  })) as { _id: string; organizationId: string; removedAt?: number } | null;

  if (!project || project.removedAt) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Project not found, skipping`);
    return;
  }

  // Fetch logs
  const { logs, error: fetchError } = await fetchLogs(env, ctx);
  if (fetchError) {
    console.error(`${LOG_PREFIX} ${ctx.logCtx}: ${fetchError}`);
    return;
  }
  if (!logs?.trim()) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: No logs available, skipping`);
    return;
  }

  // Extract errors
  const extraction = await runExtraction(env, logs);
  if (!extraction || extraction.errors.length === 0) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: No errors extracted`);
    return;
  }

  if (extraction.truncated) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Log content was truncated`);
  }

  console.log(
    `${LOG_PREFIX} ${ctx.logCtx}: Extracted ${extraction.errors.length} error(s)`
  );

  // Look up PR number
  const convex = getConvexClient(env);
  const runs = (await convex.query("runs:listByRepoCommit", {
    repository: ctx.repository,
    commitSha: ctx.commitSha,
  })) as Array<{ prNumber?: number | null }>;
  const prNumber =
    runs.find((r) => typeof r.prNumber === "number")?.prNumber ?? undefined;

  // Store errors
  const runRecordId = await storeErrors(
    env,
    ctx,
    project,
    extraction.errors,
    prNumber
  );
  if (!runRecordId) {
    return;
  }

  console.log(
    `${LOG_PREFIX} ${ctx.logCtx}: Stored ${extraction.errors.length} errors`
  );

  // Map extracted errors to RunError format for heal creation
  // This avoids re-querying the database which could have eventual consistency issues
  const runErrors: RunError[] = extraction.errors.map((e) => ({
    _id: crypto.randomUUID(),
    fixable: e.fixable ?? null,
    source: "webhook-extraction",
    signatureId: e.ruleId ?? null,
    workflowJob: ctx.jobName,
  }));

  // Create heals
  try {
    await createHealsForErrors(
      env,
      convex,
      project,
      runRecordId,
      ctx.commitSha,
      prNumber,
      runErrors
    );
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ${ctx.logCtx}: Failed to create heals:`,
      error instanceof Error ? error.message : String(error)
    );
  }
};
