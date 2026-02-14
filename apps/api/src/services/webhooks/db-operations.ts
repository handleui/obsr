import { createDb, runErrorOps, runOps } from "@detent/db";
import { type generateFingerprints, sanitizeSensitiveData } from "@detent/lore";
import type { CIError } from "@detent/types";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { getConvexClient } from "../../db/convex";
import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../../lib/cache";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../lib/org-settings";
import type { Env } from "../../types/env";
import { formatErrorsFoundComment } from "../comment-formatter";
import { createGitHubService } from "../github";
import { deleteAndPostComment } from "../github/comments";
import type { DbClient, RunIdentifier } from "./types";
import { GITHUB_NAME_PATTERN } from "./types";

export const MAX_WORKFLOW_NAME_LENGTH = 255;
export const MAX_ERROR_MESSAGE_LENGTH = 10_000;
export const MAX_FILE_PATH_LENGTH = 1000;
export const MAX_STACK_TRACE_LENGTH = 50_000;

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

export const buildSignatureInputs = (
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

  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const convex = getConvexClient(env);

    const runIds = runIdentifiers.map((r) => String(r.runId));
    const existingRunsResult =
      runIds.length > 0
        ? await runOps.listByRepositoryRunIds(db, repository, runIds)
        : [];

    const existingSet = new Set(
      existingRunsResult.map((r) => `${r.runId}:${r.runAttempt ?? 1}`)
    );
    const allExist =
      runIdentifiers.length === 0 ||
      runIdentifiers.every((r) =>
        existingSet.has(`${r.runId}:${r.runAttempt}`)
      );

    const orgSettings = cachedSettings
      ? getOrgSettings(cachedSettings)
      : await fetchAndCacheOrgSettings(
          convex,
          installationId,
          repository,
          settingsCacheKey
        );

    return { allExist, existingRuns: existingSet, orgSettings };
  } finally {
    await pool.end();
  }
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

  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const runIds = runsToCheck.map((r) => String(r.id));
    const matchedRuns = await runOps.listByRepositoryRunIds(
      db,
      repository,
      runIds
    );

    if (matchedRuns.length === 0) {
      return null;
    }

    const errorsByRun = await Promise.all(
      matchedRuns.map((run) =>
        runErrorOps.listByRunIdSource(db, run.id, "job-report", 1000)
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
  } finally {
    await pool.end();
  }
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
  if (!(owner && repo)) {
    return null;
  }
  if (!(isValidGitHubNameSegment(owner) && isValidGitHubNameSegment(repo))) {
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
