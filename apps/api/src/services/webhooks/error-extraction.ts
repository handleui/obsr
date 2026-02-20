import { type createDb, runOps, storeJobReport } from "@detent/db";
import { extractErrors, type LogSegment } from "@detent/extract";
import { type ErrorFingerprints, generateFingerprints } from "@detent/lore";
import type { CIError, HealCreateStatus } from "@detent/types";
import { scrubSecrets } from "@detent/types";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK is designed for namespace import
import * as Sentry from "@sentry/cloudflare";
import { getConvexClient } from "../../db/convex";
import { createHeal, getHealsByPr } from "../../db/operations/heals";
import { getDb } from "../../lib/db.js";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../lib/org-settings";
import type { Env } from "../../types/env";
import { hasAutofix } from "../autofix/registry";
import { canRunHeal } from "../billing";
import { createGitHubService } from "../github";
import { buildSignatureInputs, ciErrorToRow } from "./db-operations";
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

type ExtractionStatus = "success" | "failed" | "timeout" | "skipped";

interface JobExtractionResult {
  errors: CIError[];
  truncated: boolean;
  segmentsTruncated: boolean;
  status: ExtractionStatus;
  segments?: LogSegment[];
}

const LOG_PREFIX = "[error-extraction]";
const EXTRACTION_TIMEOUT_MS = 60_000;
const LOCK_TTL_SECONDS = 300;
const MAX_HEALS_PER_EXTRACTION = 10;
const RETRY_DELAYS_MS = [2000, 5000];
const MAX_R2_LOG_BYTES = 50 * 1024 * 1024;

const EXTRACTION_CONTENT_LIMIT = 15_000;
const EARLY_CUTOFF_MULTIPLIER = 3;
const SCRUB_PRE_SLICE = EXTRACTION_CONTENT_LIMIT * EARLY_CUTOFF_MULTIPLIER;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control chars for security
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u2029]/g;

const sanitizeField = (value: string, maxLen: number): string => {
  const cleaned = value.replace(CONTROL_CHAR_PATTERN, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
};

const HTTP_SERVER_ERROR = /\b50[23]\b/;
const HTTP_RATE_LIMIT = /\b429\b/;

const isRetryableError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network error") ||
    lower.includes("network timeout") ||
    lower.includes("fetch failed") ||
    HTTP_SERVER_ERROR.test(message) ||
    HTTP_RATE_LIMIT.test(message) ||
    lower.includes("rate limit")
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const countLines = (text: string): number => {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
};

const logValidationError = (field: string, value: string): false => {
  console.error(`${LOG_PREFIX} Invalid ${field}: ${safeLogValue(value)}`);
  return false;
};

const validatePayloadIds = (
  jobId: number,
  runId: number,
  installationId: number,
  repository: string,
  commitSha: string
): boolean => {
  if (!isValidJobId(jobId)) {
    return logValidationError("job ID", String(jobId));
  }
  if (!isValidJobId(runId)) {
    return logValidationError("run ID", String(runId));
  }
  if (!isValidJobId(installationId)) {
    return logValidationError("installation ID", String(installationId));
  }
  if (!isValidRepositoryFormat(repository)) {
    return logValidationError("repository format", repository);
  }
  if (!SHA_REGEX.test(commitSha)) {
    return logValidationError("commit SHA", commitSha);
  }
  return true;
};

const buildContext = (payload: WebhookPayload): ExtractionContext | null => {
  const repository = payload.repository.full_name;
  const jobId = payload.workflow_job.id;
  const runId = payload.workflow_job.run_id;
  const installationId = payload.installation.id;
  const commitSha = payload.workflow_job.head_sha;

  if (
    !validatePayloadIds(jobId, runId, installationId, repository, commitSha)
  ) {
    return null;
  }

  return {
    repository,
    jobId,
    runId,
    jobName: sanitizeField(payload.workflow_job.name, 255),
    commitSha: commitSha.toLowerCase(),
    headBranch: sanitizeField(
      payload.workflow_job.head_branch ?? "unknown",
      255
    ),
    workflowName: sanitizeField(
      payload.workflow_job.workflow_name ?? "Unknown",
      255
    ),
    installationId,
    logCtx: `${safeLogValue(repository)}#${jobId}`,
  };
};

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

  const lockId = crypto.randomUUID();
  await kv.put(lockKey, lockId, { expirationTtl: LOCK_TTL_SECONDS });

  const verification = await kv.get(lockKey);
  if (verification !== lockId) {
    return false;
  }

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
  } catch (_error) {
    return {
      logs: null,
      error: "Failed to get installation token",
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
    return { logs: null, error: "Failed to fetch workflow logs" };
  }
};

const logExtractionExhausted = (
  ctx: ExtractionContext,
  lastError: string | undefined
): JobExtractionResult => {
  const status: ExtractionStatus = lastError?.includes("timed out")
    ? "timeout"
    : "failed";
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "AI extraction failed after all retries",
      prefix: LOG_PREFIX,
      repository: ctx.repository,
      runId: ctx.runId,
      jobName: ctx.jobName,
      status,
      lastError: lastError ? sanitizeField(lastError, 500) : undefined,
      attempts: RETRY_DELAYS_MS.length + 1,
    })
  );
  return { errors: [], truncated: false, segmentsTruncated: false, status };
};

const runExtraction = async (
  env: Env,
  logContent: string,
  ctx: ExtractionContext
): Promise<JobExtractionResult> => {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await extractErrors(logContent, {
        timeout: EXTRACTION_TIMEOUT_MS,
        apiKey: env.AI_GATEWAY_API_KEY,
      });
      if (attempt > 0) {
        console.log(
          `${LOG_PREFIX} ${ctx.logCtx}: AI extraction succeeded on retry ${attempt}`
        );
      }
      return {
        errors: result.errors,
        truncated: result.truncated ?? false,
        segmentsTruncated: result.segmentsTruncated ?? false,
        status: "success",
        segments: result.segments,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      const isTimeout = message.includes("timed out");

      if (!isRetryableError(message)) {
        console.error(
          `${LOG_PREFIX} ${ctx.logCtx}: AI extraction failed (non-retryable): ${sanitizeField(message, 500)}`
        );
        return {
          errors: [],
          truncated: false,
          segmentsTruncated: false,
          status: "failed",
        };
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        console.warn(
          `${LOG_PREFIX} ${ctx.logCtx}: AI extraction ${isTimeout ? "timed out" : "failed"} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}), retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }
  }

  return logExtractionExhausted(ctx, lastError);
};

interface StoreErrorsOptions {
  db: ReturnType<typeof createDb>["db"];
  env: Env;
  ctx: ExtractionContext;
  project: { _id: string };
  errors: CIError[];
  prNumber: number | undefined;
  conclusion: string;
  totalLogLines: number;
  extractionStatus: ExtractionStatus;
  logR2Key?: string | null;
  logManifest?: LogSegment[];
  logManifestTruncated?: boolean;
  precomputedFingerprints?: Array<{
    error: CIError;
    fingerprints: ErrorFingerprints;
  }>;
}

const MAX_ERRORS_PER_JOB = 500;

const buildJobReportPayload = (
  options: StoreErrorsOptions,
  runRecordId: string
) => {
  const { ctx, project, errors, prNumber, conclusion, totalLogLines } = options;
  const cappedErrors = errors.slice(0, MAX_ERRORS_PER_JOB);
  const errorsWithFingerprints =
    options.precomputedFingerprints ??
    cappedErrors.map((e) => ({
      error: e,
      fingerprints: generateFingerprints(e),
    }));
  const errorRows = errorsWithFingerprints.map(
    ({ error: e, fingerprints }) => ({
      ...ciErrorToRow(e, runRecordId, ctx.jobName, {
        source: "webhook-extraction",
        totalLogLines,
      }),
      fingerprint: fingerprints.lore,
    })
  );

  return {
    run: {
      id: runRecordId,
      projectId: project._id,
      provider: "github" as const,
      source: "webhook-extraction" as const,
      runId: String(ctx.runId),
      repository: ctx.repository,
      commitSha: ctx.commitSha,
      headBranch: ctx.headBranch,
      prNumber,
      workflowName: ctx.workflowName,
      runAttempt: 1,
      errorCount: cappedErrors.length,
      conclusion,
      extractionStatus: options.extractionStatus,
      logR2Key: options.logR2Key,
      logManifest: options.logManifest,
      logManifestTruncated: options.logManifestTruncated || undefined,
      receivedAt: Date.now(),
    },
    errors: errorRows,
    signatures: Array.from(
      buildSignatureInputs(errorsWithFingerprints).values()
    ),
    workflowJob: ctx.jobName,
    providerJobId: String(ctx.jobId),
    source: "webhook-extraction" as const,
  };
};

const storeErrors = async (
  options: StoreErrorsOptions
): Promise<string | null> => {
  const { db, ctx, errors } = options;
  const runRecordId = crypto.randomUUID();
  const payload = buildJobReportPayload(options, runRecordId);

  try {
    await storeJobReport(db, payload);
    return runRecordId;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // HACK: strip connection strings that may leak in Neon/pg driver errors
    const message = rawMessage.replace(
      /postgres(ql)?:\/\/[^\s]+/gi,
      "[REDACTED_CONNECTION_STRING]"
    );
    console.error(`${LOG_PREFIX} ${ctx.logCtx}: Failed to store:`, message);
    Sentry.captureMessage("Failed to store extracted errors", {
      level: "error",
      extra: {
        repository: ctx.repository,
        errorCount: errors.length,
        runId: ctx.runId,
        jobName: ctx.jobName,
        error: message,
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

const hasUncoveredSignatures = (
  signatures: string[],
  existingIds: Set<string>
): boolean =>
  signatures.length === 0 || !signatures.every((id) => existingIds.has(id));

const resolveHealStatus = async (
  env: Env,
  orgSettings: Required<OrganizationSettings>,
  organizationId: string
): Promise<HealCreateStatus> => {
  if (!orgSettings.healAutoTrigger) {
    return "found";
  }
  const billing = await canRunHeal(env, organizationId);
  return billing.allowed ? "pending" : "found";
};

interface DispatchHealsOptions {
  env: Env;
  errorsByJob: Map<string, RunError[]>;
  existingSignatureIds: Set<string>;
  healStatus: HealCreateStatus;
  projectId: string;
  runRecordId: string;
  commitSha: string;
  prNumber: number | undefined;
}

const dispatchHeals = async (options: DispatchHealsOptions): Promise<void> => {
  const {
    env,
    errorsByJob,
    existingSignatureIds,
    healStatus,
    projectId,
    runRecordId,
    commitSha,
    prNumber,
  } = options;
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

    if (!hasUncoveredSignatures(signatureIds, existingSignatureIds)) {
      console.log(
        `${LOG_PREFIX} Skipping duplicate heal for job "${jobName}" - signatures already covered`
      );
      continue;
    }

    promises.push(
      createHeal(env, {
        type: "heal",
        status: healStatus,
        projectId,
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

interface CreateHealsOptions {
  env: Env;
  convex: DbClient;
  project: { _id: string; organizationId: string };
  runRecordId: string;
  commitSha: string;
  prNumber: number | undefined;
  runErrors: RunError[];
}

const createHealsForErrors = async (
  options: CreateHealsOptions
): Promise<void> => {
  const { env, convex, project, runRecordId, commitSha, prNumber, runErrors } =
    options;

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
  const healStatus = await resolveHealStatus(
    env,
    orgSettings,
    project.organizationId
  );

  await dispatchHeals({
    env,
    errorsByJob,
    existingSignatureIds,
    healStatus,
    projectId: project._id,
    runRecordId,
    commitSha,
    prNumber,
  });
};

const storeLogsInR2 = async (
  env: Env,
  organizationId: string,
  ctx: ExtractionContext,
  logs: string
): Promise<string | null> => {
  const logBytes = new Blob([logs]).size;
  if (logBytes > MAX_R2_LOG_BYTES) {
    console.warn(
      `${LOG_PREFIX} ${ctx.logCtx}: Log too large for R2 (${(logBytes / 1024 / 1024).toFixed(1)} MB), skipping storage`
    );
    return null;
  }
  try {
    const key = `logs/${organizationId}/${ctx.repository}/${ctx.runId}.txt`;
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

const findPrNumber = async (
  db: ReturnType<typeof createDb>["db"],
  repository: string,
  commitSha: string
): Promise<number | undefined> => {
  const runs = await runOps.listByRepoCommit(db, repository, commitSha);
  return (
    runs.find((r) => typeof r.prNumber === "number")?.prNumber ?? undefined
  );
};

const toRunError = (
  e: CIError,
  jobName: string,
  signatureId: string | null = null
): RunError => ({
  _id: crypto.randomUUID(),
  fixable: e.fixable ?? null,
  source: "webhook-extraction",
  signatureId,
  workflowJob: jobName,
});

interface ExtractionPipelineContext {
  sqlDb: ReturnType<typeof createDb>["db"];
  env: Env;
  ctx: ExtractionContext;
  project: { _id: string; organizationId: string };
  extraction: JobExtractionResult;
  logR2Key: string | null;
  totalLogLines: number;
  prNumber: number | undefined;
  conclusion: string;
}

const storeEmptyExtraction = async (
  pipeline: ExtractionPipelineContext
): Promise<void> => {
  await storeErrors({
    db: pipeline.sqlDb,
    env: pipeline.env,
    ctx: pipeline.ctx,
    project: pipeline.project,
    errors: [],
    prNumber: pipeline.prNumber,
    conclusion: pipeline.conclusion,
    totalLogLines: pipeline.totalLogLines,
    extractionStatus: pipeline.extraction.status,
    logR2Key: pipeline.logR2Key,
    logManifest: pipeline.extraction.segments,
    logManifestTruncated: pipeline.extraction.segmentsTruncated,
  });
  console.log(
    `${LOG_PREFIX} ${pipeline.ctx.logCtx}: No errors extracted (status=${pipeline.extraction.status})`
  );
};

const storeAndHealErrors = async (
  pipeline: ExtractionPipelineContext
): Promise<void> => {
  const { env, ctx, project, extraction, prNumber } = pipeline;

  if (extraction.truncated) {
    console.log(`${LOG_PREFIX} ${ctx.logCtx}: Log content was truncated`);
  }
  console.log(
    `${LOG_PREFIX} ${ctx.logCtx}: Extracted ${extraction.errors.length} error(s)`
  );

  const cappedErrors = extraction.errors.slice(0, MAX_ERRORS_PER_JOB);
  const errorsWithFingerprints = cappedErrors.map((e) => ({
    error: e,
    fingerprints: generateFingerprints(e),
  }));

  const runRecordId = await storeErrors({
    db: pipeline.sqlDb,
    env,
    ctx,
    project,
    errors: cappedErrors,
    prNumber,
    conclusion: pipeline.conclusion,
    totalLogLines: pipeline.totalLogLines,
    extractionStatus: extraction.status,
    logR2Key: pipeline.logR2Key,
    logManifest: extraction.segments,
    logManifestTruncated: extraction.segmentsTruncated,
    precomputedFingerprints: errorsWithFingerprints,
  });
  if (!runRecordId) {
    return;
  }

  console.log(
    `${LOG_PREFIX} ${ctx.logCtx}: Stored ${cappedErrors.length} errors`
  );

  const convex = getConvexClient(env);
  const runErrors = errorsWithFingerprints.map(({ error: e, fingerprints }) =>
    toRunError(e, ctx.jobName, fingerprints.lore)
  );

  try {
    await createHealsForErrors({
      env,
      convex,
      project,
      runRecordId,
      commitSha: ctx.commitSha,
      prNumber,
      runErrors,
    });
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ${ctx.logCtx}: Failed to create heals:`,
      error instanceof Error ? error.message : String(error)
    );
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

  const [extraction, logR2Key] = await Promise.all([
    runExtraction(env, scrubSecrets(logs.slice(0, SCRUB_PRE_SLICE)), ctx),
    storeLogsInR2(env, project.organizationId, ctx, logs),
  ]);

  const { db: sqlDb, pool } = getDb(env);
  try {
    const pipeline: ExtractionPipelineContext = {
      sqlDb,
      env,
      ctx,
      project,
      extraction,
      logR2Key,
      totalLogLines: countLines(logs),
      prNumber: await findPrNumber(sqlDb, ctx.repository, ctx.commitSha),
      conclusion: sanitizeField(
        payload.workflow_job.conclusion ?? "failure",
        50
      ),
    };

    if (extraction.status !== "success" || extraction.errors.length === 0) {
      await storeEmptyExtraction(pipeline);
      return;
    }

    await storeAndHealErrors(pipeline);
  } finally {
    await pool.end();
  }
};
