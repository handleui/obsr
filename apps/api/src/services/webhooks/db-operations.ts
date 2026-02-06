import { generateFingerprints, sanitizeSensitiveData } from "@detent/lore";
import type { ErrorCategory, ErrorSource } from "@detent/types";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { getConvexClient } from "../../db/convex";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../lib/org-settings";
import { formatErrorsFoundComment } from "../comment-formatter";
import { createGitHubService } from "../github";
import { deleteAndPostComment } from "../github/comments";

const asSource = (s: string | undefined): ErrorSource | undefined =>
  s as ErrorSource | undefined;

const asCategory = (c: string | undefined): ErrorCategory | undefined =>
  c as ErrorCategory | undefined;

import type { CIError } from "@detent/types";
import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../../lib/cache";
import type { Env } from "../../types/env";
import type { DbClient, PreparedRunData, RunIdentifier } from "./types";
import { GITHUB_NAME_PATTERN, SHA_REGEX } from "./types";

export const MAX_WORKFLOW_NAME_LENGTH = 255;
export const MAX_BRANCH_NAME_LENGTH = 255;
export const MAX_CONCLUSION_LENGTH = 50;
export const MAX_REPOSITORY_LENGTH = 200;
export const MAX_ERROR_MESSAGE_LENGTH = 10_000;
export const MAX_FILE_PATH_LENGTH = 1000;
export const MAX_STACK_TRACE_LENGTH = 50_000;

export const MAX_RUN_ID = Number.MAX_SAFE_INTEGER;
export const MAX_PR_NUMBER = 1_000_000_000;

export const MAX_RUN_ATTEMPT = 100;
export const MAX_LINE_NUMBER = 10_000_000;
export const MAX_COLUMN_NUMBER = 100_000;

export const validatePositiveInt = (
  value: unknown,
  max: number
): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, max);
};

export const validateLineRange = (
  start: number | null,
  end: number | null
): { start: number | null; end: number | null } => {
  if (start === null || end === null) {
    return { start: null, end: null };
  }
  if (end < start) {
    return { start: null, end: null };
  }
  return { start, end };
};

export const truncateString = (
  value: unknown,
  maxLength: number
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

/**
 * Clamps log line range to the actual log size.
 * Precondition: `start` and `end` must either both be null or form a valid range (start <= end).
 * Call `validateLineRange` first to ensure this invariant.
 */
export const clampLogLines = (
  start: number | null,
  end: number | null,
  totalLines: number
): { start: number | null; end: number | null } => {
  const clampedStart = start !== null && start > totalLines ? null : start;
  if (end === null || end <= totalLines) {
    return { start: clampedStart, end };
  }
  const clampedEnd = clampedStart !== null ? totalLines : null;
  return { start: clampedStart, end: clampedEnd };
};

export const ciErrorToRow = (
  error: CIError,
  runId: string,
  job: string,
  opts?: { source?: string; totalLogLines?: number; createdAt?: number }
) => {
  const rawStart = validatePositiveInt(error.logLineStart, 1_000_000);
  const rawEnd = validatePositiveInt(error.logLineEnd, 1_000_000);
  const rangeValidated = validateLineRange(rawStart, rawEnd);
  const { start: logLineStart, end: logLineEnd } = opts?.totalLogLines
    ? clampLogLines(
        rangeValidated.start,
        rangeValidated.end,
        opts.totalLogLines
      )
    : rangeValidated;

  return {
    runId,
    message:
      truncateString(error.message, MAX_ERROR_MESSAGE_LENGTH) ??
      "Unknown error",
    filePath: truncateString(error.filePath, MAX_FILE_PATH_LENGTH),
    line: validatePositiveInt(error.line, MAX_LINE_NUMBER),
    column: validatePositiveInt(error.column, MAX_COLUMN_NUMBER),
    category: truncateString(error.category, 100),
    severity: truncateString(error.severity, 50) ?? "error",
    ruleId: truncateString(error.ruleId, 200),
    source: opts?.source ?? error.source,
    stackTrace: truncateString(error.stackTrace, MAX_STACK_TRACE_LENGTH),
    codeSnippet: error.codeSnippet ?? null,
    relatedFiles: error.relatedFiles ?? null,
    hints: error.hints ?? null,
    workflowJob:
      truncateString(
        error.workflowJob ?? error.workflowContext?.job,
        MAX_WORKFLOW_NAME_LENGTH
      ) ?? job,
    workflowStep: truncateString(
      error.workflowContext?.step,
      MAX_WORKFLOW_NAME_LENGTH
    ),
    workflowAction: truncateString(
      error.workflowContext?.action,
      MAX_WORKFLOW_NAME_LENGTH
    ),
    fixable: error.fixable ?? null,
    logLineStart,
    logLineEnd,
    createdAt: opts?.createdAt ?? Date.now(),
  };
};

export const prepareRunData = (data: {
  runId: number;
  runName: string;
  prNumber: number;
  headSha: string;
  errors: CIError[];
  repository: string;
  checkRunId?: number;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
}): PreparedRunData | null => {
  const validatedRunId = validatePositiveInt(data.runId, MAX_RUN_ID);
  const validatedPrNumber = validatePositiveInt(data.prNumber, MAX_PR_NUMBER);
  const validatedRunAttempt =
    validatePositiveInt(data.runAttempt, MAX_RUN_ATTEMPT) ?? 1;
  const validatedCheckRunId = data.checkRunId
    ? validatePositiveInt(data.checkRunId, MAX_RUN_ID)
    : null;

  if (validatedRunId === null || validatedPrNumber === null) {
    console.error(
      `[workflow_run] Invalid run ID (${data.runId}) or PR number (${data.prNumber})`
    );
    return null;
  }

  if (!SHA_REGEX.test(data.headSha)) {
    console.error(
      `[workflow_run] Invalid SHA format: ${data.headSha.slice(0, 20)}...`
    );
    return null;
  }

  return {
    runRecordId: crypto.randomUUID(),
    runId: validatedRunId,
    runName:
      truncateString(data.runName, MAX_WORKFLOW_NAME_LENGTH) ?? "Unknown",
    prNumber: validatedPrNumber,
    headSha: data.headSha.toLowerCase(),
    errors: data.errors,
    repository: truncateString(data.repository, MAX_REPOSITORY_LENGTH) ?? "",
    checkRunId: validatedCheckRunId,
    conclusion: data.conclusion
      ? truncateString(data.conclusion, MAX_CONCLUSION_LENGTH)
      : null,
    headBranch:
      truncateString(data.headBranch, MAX_BRANCH_NAME_LENGTH) ?? "unknown",
    runAttempt: validatedRunAttempt,
    runStartedAt: data.runStartedAt,
  };
};

const collectErrorFingerprints = (preparedRuns: PreparedRunData[]) => {
  const errorsWithFingerprints: Array<{
    error: CIError;
    fingerprints: ReturnType<typeof generateFingerprints>;
    runRecordId: string;
    runName: string;
  }> = [];

  for (const data of preparedRuns) {
    for (const error of data.errors) {
      const fingerprints = generateFingerprints({
        message: error.message,
        filePath: error.filePath,
        line: error.line,
        column: error.column,
        source: asSource(error.source),
        ruleId: error.ruleId,
        category: asCategory(error.category),
      });
      errorsWithFingerprints.push({
        error,
        fingerprints,
        runRecordId: data.runRecordId,
        runName: data.runName,
      });
    }
  }
  return errorsWithFingerprints;
};

const buildSignatureInputs = (
  errorsWithFingerprints: Array<{
    error: CIError;
    fingerprints: ReturnType<typeof generateFingerprints>;
  }>
) => {
  const signatureInputs = new Map<
    string,
    {
      fingerprint: string;
      source?: string;
      ruleId?: string;
      category?: string;
      normalizedPattern?: string;
      exampleMessage?: string;
      filePath?: string;
    }
  >();

  for (const entry of errorsWithFingerprints) {
    const fingerprint = entry.fingerprints.lore;
    if (!signatureInputs.has(fingerprint)) {
      signatureInputs.set(fingerprint, {
        fingerprint,
        source: entry.error.source,
        ruleId: entry.error.ruleId,
        category: entry.error.category,
        normalizedPattern: entry.fingerprints.normalizedPattern,
        exampleMessage: sanitizeSensitiveData(entry.error.message).slice(
          0,
          500
        ),
        filePath: entry.error.filePath,
      });
    }
  }
  return signatureInputs;
};

const resolveProjectId = async (
  convex: ReturnType<typeof getConvexClient>,
  firstRun: PreparedRunData,
  errorCount: number
): Promise<string | null> => {
  if (firstRun.projectId) {
    return firstRun.projectId;
  }

  const project = (await convex.query("projects:getByRepoFullName", {
    providerRepoFullName: firstRun.repository,
  })) as { _id: string; removedAt?: number } | null;

  if (project && !project.removedAt) {
    return project._id;
  }

  if (errorCount > 0) {
    Sentry.captureMessage(
      "Project not found for repository during error tracking",
      {
        level: "warning",
        extra: {
          repository: firstRun.repository,
          errorCount,
        },
      }
    );
  }
  return null;
};

const buildRunRow = (
  data: PreparedRunData,
  projectId: string,
  completedAt: number
) => ({
  id: data.runRecordId,
  projectId: data.projectId ?? projectId,
  provider: "github" as const,
  source: "github",
  format: "github-actions",
  runId: String(data.runId),
  repository: data.repository,
  commitSha: data.headSha,
  prNumber: data.prNumber,
  checkRunId: data.checkRunId ? String(data.checkRunId) : undefined,
  errorCount: data.errors.length,
  workflowName: data.runName,
  conclusion: data.conclusion ?? undefined,
  headBranch: data.headBranch,
  runAttempt: data.runAttempt,
  runStartedAt: data.runStartedAt ? data.runStartedAt.getTime() : undefined,
  runCompletedAt: completedAt,
  receivedAt: completedAt,
});

const buildErrorRow = (
  entry: {
    error: CIError;
    fingerprints: ReturnType<typeof generateFingerprints>;
    runRecordId: string;
    runName: string;
  },
  completedAt: number
) => ({
  ...ciErrorToRow(entry.error, entry.runRecordId, entry.runName, {
    createdAt: completedAt,
  }),
  fingerprint: entry.fingerprints.lore,
});

export const bulkStoreRunsAndErrors = async (
  env: Env,
  preparedRuns: PreparedRunData[]
): Promise<void> => {
  if (preparedRuns.length === 0) {
    return;
  }

  const convex = getConvexClient(env);
  const completedAt = Date.now();
  const errorsWithFingerprints = collectErrorFingerprints(preparedRuns);

  const firstRun = preparedRuns[0];
  if (!firstRun) {
    return;
  }

  const projectId = await resolveProjectId(
    convex,
    firstRun,
    errorsWithFingerprints.length
  );
  if (!projectId) {
    return;
  }

  await convex.mutation("run_ingest:bulkStore", {
    runs: preparedRuns.map((data) => buildRunRow(data, projectId, completedAt)),
    errors: errorsWithFingerprints.map((entry) =>
      buildErrorRow(entry, completedAt)
    ),
    signatures: Array.from(
      buildSignatureInputs(errorsWithFingerprints).values()
    ),
    projectId,
    commitSha: firstRun.headSha,
  });

  const totalErrors = preparedRuns.reduce((sum, r) => sum + r.errors.length, 0);
  console.log(
    `[workflow_run] Bulk stored ${preparedRuns.length} runs with ${totalErrors} total errors`
  );
};

const fetchAndCacheOrgSettings = async (
  convex: ReturnType<typeof getConvexClient>,
  installationId: number,
  repository: string,
  settingsCacheKey: string
): Promise<Required<OrganizationSettings>> => {
  let settings: OrganizationSettings | null = null;
  try {
    const orgs = (await convex.query(
      "organizations:listByProviderInstallationId",
      { providerInstallationId: String(installationId) }
    )) as Array<{ settings?: OrganizationSettings | null }>;
    settings = orgs[0]?.settings ?? null;
  } catch (error) {
    Sentry.captureException(error, {
      extra: { installationId, repository },
      tags: { operation: "org_settings_query" },
    });
  }

  setInCache(settingsCacheKey, settings, CACHE_TTL.ORG_SETTINGS);
  return getOrgSettings(settings);
};

export const checkRunsAndLoadOrgSettings = async (
  env: Env,
  repository: string,
  runIdentifiers: RunIdentifier[],
  installationId: number
): Promise<{
  allExist: boolean;
  existingRuns: Set<string>;
  orgSettings: Required<OrganizationSettings>;
}> => {
  const settingsCacheKey = cacheKey.orgSettings(installationId);
  const cachedSettings = getFromCache<OrganizationSettings>(settingsCacheKey);

  if (cachedSettings && runIdentifiers.length === 0) {
    return {
      allExist: true,
      existingRuns: new Set(),
      orgSettings: getOrgSettings(cachedSettings),
    };
  }

  const convex = getConvexClient(env);

  const runIds = runIdentifiers.map((r) => String(r.runId));
  const existingRunsResult =
    runIds.length > 0
      ? ((await convex.query("runs:listByRepositoryRunIds", {
          repository,
          runIds,
        })) as Array<{ runId: string; runAttempt: number }>)
      : [];

  const existingSet = new Set(
    existingRunsResult.map((r) => `${r.runId}:${r.runAttempt ?? 1}`)
  );
  const allExist =
    runIdentifiers.length === 0 ||
    runIdentifiers.every((r) => existingSet.has(`${r.runId}:${r.runAttempt}`));

  const orgSettings = cachedSettings
    ? getOrgSettings(cachedSettings)
    : await fetchAndCacheOrgSettings(
        convex,
        installationId,
        repository,
        settingsCacheKey
      );

  return { allExist, existingRuns: existingSet, orgSettings };
};

export const getCommentIdFromDb = async (
  db: DbClient,
  repository: string,
  prNumber: number
): Promise<string | null> => {
  try {
    const result = (await db.query("pr_comments:getByRepoPr", {
      repository: repository.toLowerCase(),
      prNumber,
    })) as { commentId: string } | null;
    return result?.commentId ?? null;
  } catch (error) {
    console.error(
      `[pr-comments] getCommentIdFromDb failed for ${repository}#${prNumber}:`,
      error
    );
    return null;
  }
};

export const upsertCommentIdInDb = async (
  db: DbClient,
  repository: string,
  prNumber: number,
  commentId: string
): Promise<void> => {
  const normalizedRepo = repository.toLowerCase();

  try {
    await db.mutation("pr_comments:upsertByRepoPr", {
      repository: normalizedRepo,
      prNumber,
      commentId,
    });
    console.log(
      `[pr-comments] Upserted comment ID in DB for ${repository}#${prNumber}: ${commentId}`
    );
  } catch (error) {
    console.error(
      `[pr-comments] upsertCommentIdInDb failed for ${repository}#${prNumber}:`,
      error
    );
  }
};

export interface JobReportedError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  category?: string;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  workflowJob?: string;
  source?: string;
}

export const checkForJobReportedErrors = async (
  env: Env,
  repository: string,
  runsToCheck: Array<{ id: number }>
): Promise<JobReportedError[] | null> => {
  if (runsToCheck.length === 0) {
    return null;
  }

  const convex = getConvexClient(env);
  const runIds = runsToCheck.map((r) => String(r.id));
  const runs = (await convex.query("runs:listByRepositoryRunIds", {
    repository,
    runIds,
  })) as Array<{ _id: string }>;

  if (runs.length === 0) {
    return null;
  }

  const errorsByRun = await Promise.all(
    runs.map((run) =>
      convex.query("run_errors:listByRunIdSource", {
        runId: run._id,
        source: "job-report",
        limit: 1000,
      })
    )
  );

  const jobReportedErrors = errorsByRun.flat() as Array<{
    message: string;
    filePath?: string;
    line?: number;
    column?: number;
    category?: string;
    severity?: string;
    ruleId?: string;
    stackTrace?: string;
    workflowJob?: string;
    source?: string;
  }>;

  if (jobReportedErrors.length === 0) {
    return null;
  }

  return jobReportedErrors.map((e) => ({
    message: e.message,
    filePath: e.filePath ?? undefined,
    line: e.line ?? undefined,
    column: e.column ?? undefined,
    category: e.category ?? undefined,
    severity: e.severity as "error" | "warning" | undefined,
    ruleId: e.ruleId ?? undefined,
    stackTrace: e.stackTrace ?? undefined,
    workflowJob: e.workflowJob ?? undefined,
    source: e.source ?? undefined,
  }));
};

const isValidGitHubNameSegment = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 100 &&
  GITHUB_NAME_PATTERN.test(name) &&
  !name.includes("..");

export interface ProjectContext {
  projectId: string;
  installationId: number;
}

interface PostErrorsCommentOptions {
  env: Env;
  db: DbClient;
  repository: string;
  prNumber: number;
  errorCount: number;
  failedRunCount: number;
  projectContext?: ProjectContext;
}

const parseRepoOwner = (
  repository: string
): { owner: string; repo: string } | null => {
  const [owner, repo] = repository.split("/");
  if (
    !(
      owner &&
      repo &&
      isValidGitHubNameSegment(owner) &&
      isValidGitHubNameSegment(repo)
    )
  ) {
    return null;
  }
  return { owner, repo };
};

export const postErrorsFoundCommentForRun = async (
  options: PostErrorsCommentOptions
): Promise<void> => {
  const {
    env,
    db,
    repository,
    prNumber,
    errorCount,
    failedRunCount,
    projectContext,
  } = options;

  const parsed = parseRepoOwner(repository);
  if (!parsed) {
    console.log(
      `[report] Invalid repository format: ${repository.slice(0, 100)}, skipping comment`
    );
    return;
  }

  const resolved =
    projectContext ?? (await getProjectContextForComment(db, repository));
  if (!resolved) {
    console.log(
      `[report] Project context not found for ${repository}, skipping comment`
    );
    return;
  }

  const { projectId, installationId } = resolved;
  const commentBody = formatErrorsFoundComment({
    errorCount,
    jobCount: failedRunCount,
    projectUrl: `${env.NAVIGATOR_BASE_URL}/dashboard/${projectId}`,
  });

  const github = createGitHubService(env);
  const token = await github.getInstallationToken(installationId);

  await deleteAndPostComment({
    github,
    token,
    kv: env["detent-idempotency"],
    db,
    owner: parsed.owner,
    repo: parsed.repo,
    repository,
    prNumber,
    commentBody,
    appId: Number.parseInt(env.GITHUB_APP_ID, 10),
  });

  console.log(
    `[report] Posted errors-found comment on ${repository}#${prNumber}`
  );
};

export const getProjectContextForComment = async (
  db: DbClient,
  repository: string
): Promise<{ projectId: string; installationId: number } | null> => {
  const project = (await db.query("projects:getByRepoFullName", {
    providerRepoFullName: repository,
  })) as { _id: string; organizationId: string; removedAt?: number } | null;

  if (!project || project.removedAt) {
    return null;
  }

  const org = (await db.query("organizations:getById", {
    id: project.organizationId,
  })) as { providerInstallationId?: string | null } | null;

  if (!org?.providerInstallationId) {
    return null;
  }

  return {
    projectId: project._id,
    installationId: Number.parseInt(org.providerInstallationId, 10),
  };
};
