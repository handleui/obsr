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
import {
  isValidJobId,
  isValidRepositoryFormat,
  SHA_REGEX,
  safeLogValue,
} from "./types";

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
    conclusion: string | null;
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

const LOG_PREFIX = "[error-extraction]";
const EXTRACTION_TIMEOUT_MS = 60_000;
const LOCK_TTL_SECONDS = 300;
const MAX_HEALS_PER_EXTRACTION = 10;
// SECURITY: Cap R2 log storage at 50 MB to prevent storage abuse
const MAX_R2_LOG_BYTES = 50 * 1024 * 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control chars for security
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u2029]/g;

// SECURITY: Sanitize webhook string fields (strip control chars + truncate to limit)
const sanitizeField = (value: string, maxLen: number): string => {
  const cleaned = value.replace(CONTROL_CHAR_PATTERN, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
};

const buildContext = (payload: WebhookPayload): ExtractionContext | null => {
  const repository = payload.repository.full_name;
  const jobId = payload.workflow_job.id;
  const runId = payload.workflow_job.run_id;

  if (!isValidJobId(jobId)) {
    console.error(
      `${LOG_PREFIX} Invalid job ID: ${safeLogValue(String(jobId))}`
    );
    return null;
  }

  if (!isValidJobId(runId)) {
    console.error(
      `${LOG_PREFIX} Invalid run ID: ${safeLogValue(String(runId))}`
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
    runId,
    jobName: sanitizeField(payload.workflow_job.name, 255),
    commitSha: commitSha.toLowerCase(),
    // SECURITY: Sanitize webhook fields to prevent control char injection and DB bloat
    headBranch: sanitizeField(
      payload.workflow_job.head_branch ?? "unknown",
      255
    ),
    workflowName: sanitizeField(
      payload.workflow_job.workflow_name ?? "Unknown",
      255
    ),
    installationId: payload.installation.id,
    logCtx: `${safeLogValue(repository)}#${jobId}`,
  };
};

// KV has no atomic CAS, so we use a simple dedup key.
// Duplicate extractions are idempotent (storeJobReport upserts), so the rare
// race where two workers both proceed is harmless.
const acquireLock = async (
  kv: KVNamespace,
  repository: string,
  jobId: number
): Promise<boolean> => {
  const lockKey = `lock:extract:${repository}:${jobId}`;

  const existing = await kv.get(lockKey);
  if (existing) {
    return false;
  }

  await kv.put(lockKey, "1", { expirationTtl: LOCK_TTL_SECONDS });
  return true;
};

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
      return { logs: null };
    }
    return { logs: null, error: `Failed to fetch logs: ${message}` };
  }
};

const runExtraction = async (
  env: Env,
  logContent: string
): Promise<{ errors: CIError[]; truncated: boolean } | null> => {
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

const mapExtractedToRow = (e: CIError, runId: string, job: string) => ({
  runId,
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
  prNumber: number | undefined,
  conclusion: string,
  logR2Key?: string | null
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
        conclusion,
        logR2Key,
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
): Map<string, RunError[]> =>
  runErrors.reduce((groups, error) => {
    if (typeof error.workflowJob !== "string" || !error.workflowJob) {
      return groups;
    }
    if (isErrorAutofixable(error)) {
      return groups;
    }
    const existing = groups.get(error.workflowJob) ?? [];
    existing.push(error);
    return groups.set(error.workflowJob, existing);
  }, new Map<string, RunError[]>());

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

  const [organization, healsByPr] = await Promise.all([
    convex.query("organizations:getById", {
      id: project.organizationId,
    }) as Promise<{ settings?: OrganizationSettings | null } | null>,
    prNumber ? getHealsByPr(env, project._id, prNumber) : Promise.resolve([]),
  ]);

  const orgSettings = getOrgSettings(organization?.settings);

  const existingSignatureIds = new Set(
    healsByPr
      .filter((h) => h.type === "heal")
      .flatMap((h) => h.signatureIds ?? [])
  );

  const errorsByJob = groupErrorsByWorkflowJob(runErrors);

  let healStatus: HealCreateStatus = "found";
  if (orgSettings.healAutoTrigger) {
    const billing = await canRunHeal(env, project.organizationId);
    if (billing.allowed) {
      healStatus = "pending";
    }
  }

  const shouldCreateHeal = (
    signatures: string[],
    existingIds: Set<string>
  ): boolean => {
    if (signatures.length === 0) {
      return true;
    }
    return !signatures.every((id) => existingIds.has(id));
  };

  const promises: Promise<string>[] = [];
  for (const [jobName, errors] of errorsByJob.entries()) {
    if (promises.length >= MAX_HEALS_PER_EXTRACTION) {
      console.warn(
        `${LOG_PREFIX} Hit max heals limit (${MAX_HEALS_PER_EXTRACTION}), skipping remaining jobs`
      );
      break;
    }

    if (errors.length === 0) {
      continue;
    }

    const signatureIds = errors
      .map((e) => e.signatureId)
      .filter((id): id is string => typeof id === "string");

    if (!shouldCreateHeal(signatureIds, existingSignatureIds)) {
      console.log(
        `${LOG_PREFIX} Skipping duplicate heal for job "${jobName}" - signatures already covered`
      );
      continue;
    }

    promises.push(
      createHeal(env, {
        type: "heal",
        status: healStatus,
        projectId: project._id,
        runId: runRecordId,
        commitSha,
        prNumber,
        signatureIds,
      })
    );
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    console.log(`${LOG_PREFIX} Created ${promises.length} heal(s)`);
  }
};

export const extractAndStoreErrors = async (
  env: Env,
  payload: WebhookPayload,
  db: DbClient
): Promise<void> => {
  const ctx = buildContext(payload);
  if (!ctx) {
    return;
  }

  const lockAcquired = await acquireLock(
    env["detent-idempotency"],
    ctx.repository,
    ctx.jobId
  );
  if (!lockAcquired) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Already processing, skipping`);
    return;
  }

  const project = (await db.query("projects:getByRepoFullName", {
    providerRepoFullName: ctx.repository,
  })) as { _id: string; organizationId: string; removedAt?: number } | null;

  if (!project || project.removedAt) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Project not found, skipping`);
    return;
  }

  const { logs, error: fetchError } = await fetchLogs(env, ctx);
  if (fetchError) {
    console.error(`${LOG_PREFIX} ${ctx.logCtx}: ${fetchError}`);
    return;
  }
  if (!logs?.trim()) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: No logs available, skipping`);
    return;
  }

  const storeLogsInR2 = async (): Promise<string | null> => {
    // SECURITY: Enforce size limit to prevent R2 storage abuse
    const logBytes = new Blob([logs]).size;
    if (logBytes > MAX_R2_LOG_BYTES) {
      console.warn(
        `${LOG_PREFIX} ${ctx.logCtx}: Log too large for R2 (${(logBytes / 1024 / 1024).toFixed(1)} MB), skipping storage`
      );
      return null;
    }
    try {
      // Key is per-run (not per-job) since fetchWorkflowLogs returns all logs for the run
      const key = `logs/${project.organizationId}/${ctx.repository}/${ctx.runId}.txt`;
      await env.LOGS_BUCKET.put(key, logs, {
        httpMetadata: { contentType: "text/plain" },
      });
      return key;
    } catch (e) {
      console.error(
        `${LOG_PREFIX} ${ctx.logCtx}: R2 put failed:`,
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }
  };

  const [extraction, logR2Key] = await Promise.all([
    runExtraction(env, logs),
    storeLogsInR2(),
  ]);
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

  const convex = getConvexClient(env);
  const runs = (await convex.query("runs:listByRepoCommit", {
    repository: ctx.repository,
    commitSha: ctx.commitSha,
  })) as Array<{ prNumber?: number | null }>;
  const prNumber =
    runs.find((r) => typeof r.prNumber === "number")?.prNumber ?? undefined;

  // SECURITY: Sanitize conclusion to prevent control char injection and DB bloat
  const conclusion = sanitizeField(
    payload.workflow_job.conclusion ?? "failure",
    50
  );
  const runRecordId = await storeErrors(
    env,
    ctx,
    project,
    extraction.errors,
    prNumber,
    conclusion,
    logR2Key
  );
  if (!runRecordId) {
    return;
  }

  console.log(
    `${LOG_PREFIX} ${ctx.logCtx}: Stored ${extraction.errors.length} errors`
  );

  const toRunError = (e: CIError, jobName: string): RunError => ({
    _id: crypto.randomUUID(),
    fixable: e.fixable ?? null,
    source: "webhook-extraction",
    signatureId: e.ruleId ?? null,
    workflowJob: jobName,
  });

  const runErrors: RunError[] = extraction.errors.map((e) =>
    toRunError(e, ctx.jobName)
  );

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
