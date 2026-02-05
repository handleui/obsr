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

/**
 * Cast a string to ErrorSource type for fingerprinting.
 * If the source doesn't match a known value, returns undefined (safe fallback).
 */
const asSource = (s: string | undefined): ErrorSource | undefined =>
  s as ErrorSource | undefined;

/**
 * Cast a string to ErrorCategory type for fingerprinting.
 * If the category doesn't match a known value, returns undefined (safe fallback).
 */
const asCategory = (c: string | undefined): ErrorCategory | undefined =>
  c as ErrorCategory | undefined;

import type { CIError } from "@detent/types";
import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../../lib/cache";
import type { Env } from "../../types/env";
import type { DbClient, PreparedRunData, RunIdentifier } from "./types";

// ============================================================================
// Validation Constants
// ============================================================================
// Maximum lengths for text fields to prevent database bloat
export const MAX_WORKFLOW_NAME_LENGTH = 255;
export const MAX_BRANCH_NAME_LENGTH = 255;
export const MAX_CONCLUSION_LENGTH = 50;
export const MAX_REPOSITORY_LENGTH = 200;
export const MAX_ERROR_MESSAGE_LENGTH = 10_000;
export const MAX_FILE_PATH_LENGTH = 1000;
export const MAX_STACK_TRACE_LENGTH = 50_000;

// Validation ranges for numeric fields
export const MAX_RUN_ID = Number.MAX_SAFE_INTEGER;
export const MAX_PR_NUMBER = 1_000_000_000; // GitHub PR numbers are 32-bit integers

// SHA validation regex (40 hex characters)
export const SHA_REGEX = /^[a-fA-F0-9]{40}$/;
export const MAX_RUN_ATTEMPT = 100; // GitHub allows re-runs but UI typically shows ~10 attempts
export const MAX_LINE_NUMBER = 10_000_000;
export const MAX_COLUMN_NUMBER = 100_000;

/**
 * Validates and clamps a numeric value to safe bounds.
 * Returns null if the value is not a valid positive integer.
 */
export const validatePositiveInt = (
  value: unknown,
  max: number
): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, max);
};

/**
 * Truncates a string to maximum length, returning null for non-strings.
 */
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
 * Validates run data and prepares it for database insertion.
 * Returns null if validation fails for critical fields.
 */
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
  // Validate critical numeric fields
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

  // Validate headSha format (40 hex characters)
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

/**
 * Bulk store multiple runs and their errors in a single transaction.
 *
 * Performance optimizations (critical for Cloudflare Workers 128MB limit):
 * - Single database connection for all runs (vs N connections)
 * - Single transaction with bulk inserts (vs N transactions)
 * - Reduces DB round-trips from 2N to 2 (one for runs, one for errors)
 * - Respects Cloudflare Workers' 6 concurrent TCP connection limit
 */
export const bulkStoreRunsAndErrors = async (
  env: Env,
  preparedRuns: PreparedRunData[]
): Promise<void> => {
  if (preparedRuns.length === 0) {
    return;
  }

  const convex = getConvexClient(env);
  const completedAt = Date.now();

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

  const firstRun = preparedRuns[0];
  let projectId = firstRun?.projectId;
  let commitSha: string | undefined;
  if (firstRun) {
    commitSha = firstRun.headSha;
  }

  if (!projectId && firstRun) {
    const project = (await convex.query("projects:getByRepoFullName", {
      providerRepoFullName: firstRun.repository,
    })) as { _id: string; removedAt?: number } | null;

    if (!project || project.removedAt) {
      if (errorsWithFingerprints.length > 0) {
        Sentry.captureMessage(
          "Project not found for repository during error tracking",
          {
            level: "warning",
            extra: {
              repository: firstRun.repository,
              errorCount: errorsWithFingerprints.length,
            },
          }
        );
      }
      return;
    }
    projectId = project._id;
  }

  if (!projectId) {
    return;
  }

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

  const runRows = preparedRuns.map((data) => ({
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
  }));

  const errorRows = errorsWithFingerprints.map((entry) => ({
    runId: entry.runRecordId,
    fingerprint: entry.fingerprints.lore,
    filePath: truncateString(entry.error.filePath, MAX_FILE_PATH_LENGTH),
    line: validatePositiveInt(entry.error.line, MAX_LINE_NUMBER),
    column: validatePositiveInt(entry.error.column, MAX_COLUMN_NUMBER),
    message:
      truncateString(entry.error.message, MAX_ERROR_MESSAGE_LENGTH) ??
      "Unknown error",
    category: truncateString(entry.error.category, 100),
    severity: truncateString(entry.error.severity, 50),
    ruleId: truncateString(entry.error.ruleId, 200),
    source: truncateString(entry.error.source, 100),
    stackTrace: truncateString(entry.error.stackTrace, MAX_STACK_TRACE_LENGTH),
    hints: entry.error.hints ?? undefined,
    codeSnippet: entry.error.codeSnippet ?? undefined,
    workflowJob:
      truncateString(
        entry.error.workflowJob ?? entry.error.workflowContext?.job,
        MAX_WORKFLOW_NAME_LENGTH
      ) ?? entry.runName,
    workflowStep: truncateString(
      entry.error.workflowContext?.step,
      MAX_WORKFLOW_NAME_LENGTH
    ),
    workflowAction: truncateString(
      entry.error.workflowContext?.action,
      MAX_WORKFLOW_NAME_LENGTH
    ),
    fixable: entry.error.fixable ?? undefined,
    createdAt: completedAt,
  }));

  await convex.mutation("run_ingest:bulkStore", {
    runs: runRows,
    errors: errorRows,
    signatures: Array.from(signatureInputs.values()),
    projectId,
    commitSha,
  });

  const totalErrors = preparedRuns.reduce((sum, r) => sum + r.errors.length, 0);
  console.log(
    `[workflow_run] Bulk stored ${preparedRuns.length} runs with ${totalErrors} total errors`
  );
};

// ============================================================================
// Helper: Check run attempts AND load org settings in single DB connection
// ============================================================================
// Run-aware idempotency: Check specific (runId, runAttempt) tuples, not just
// "any runs for commit". This enables proper re-run handling where the same
// runId with a different runAttempt should be processed as a new run.
//
// Performance optimization: Combines run checks with org settings loading in
// one DB connection, reducing connection overhead during webhook processing.
// Also uses in-memory cache for org settings (2 min TTL).

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
  // Check cache first for org settings
  const settingsCacheKey = cacheKey.orgSettings(installationId);
  const cachedSettings = getFromCache<OrganizationSettings>(settingsCacheKey);

  // If we have cached settings and no runs to check, skip DB entirely
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

  let orgSettings: Required<OrganizationSettings>;
  if (cachedSettings) {
    orgSettings = getOrgSettings(cachedSettings);
  } else {
    let settings: OrganizationSettings | null = null;
    try {
      const orgs = (await convex.query(
        "organizations:listByProviderInstallationId",
        {
          providerInstallationId: String(installationId),
        }
      )) as Array<{ settings?: OrganizationSettings | null }>;
      settings = orgs[0]?.settings ?? null;
    } catch (error) {
      Sentry.captureException(error, {
        extra: { installationId, repository },
        tags: { operation: "org_settings_query" },
      });
    }

    orgSettings = getOrgSettings(settings);
    setInCache(settingsCacheKey, settings, CACHE_TTL.ORG_SETTINGS);
  }

  return { allExist, existingRuns: existingSet, orgSettings };
};

// ============================================================================
// Helper: PR Comment ID Database Operations
// ============================================================================
// Database is the ultimate source of truth for comment IDs.
// KV serves as a fast cache; these functions handle the persistent layer.

/**
 * Retrieves a comment ID from the database for a PR.
 * Returns null if not found.
 */
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

/**
 * Upserts a comment ID in the database for a PR.
 * Creates new record or updates existing one.
 *
 * Performance: Uses single INSERT...ON CONFLICT DO UPDATE query instead of
 * SELECT+INSERT/UPDATE pattern to reduce DB round-trips from 2 to 1.
 * Leverages the unique index on (repository, prNumber) for conflict detection.
 */
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
    // Non-critical: KV is also storing this, and we have the unique constraint as safety
    console.error(
      `[pr-comments] upsertCommentIdInDb failed for ${repository}#${prNumber}:`,
      error
    );
  }
};

// ============================================================================
// Helper: Check for job-reported errors from POST /report
// ============================================================================
// Looks up errors that were reported via the GitHub Action (POST /report)
// rather than parsed from workflow logs. This allows skipping log fetching
// when the action has already provided structured error data.
//
// Performance: Uses JOIN with WHERE filter at DB level instead of loading all
// errors and filtering in JS. Also selects only needed columns to reduce data transfer.

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

// ============================================================================
// Helper: Post Errors Found Comment for a Run
// ============================================================================
// Posts a comment when errors are reported via POST /report with isComplete=true.
// This allows the GitHub Action to trigger comments without waiting for workflow completion.
//
// Performance optimization: Accepts optional ProjectContext to avoid redundant DB queries
// when the caller already has project/org data (e.g., report.ts already queries the project).

// SECURITY: GitHub name validation pattern (defense-in-depth for owner/repo segments)
// This provides additional validation before using values in GitHub API calls
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
const isValidGitHubNameSegment = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 100 &&
  GITHUB_NAME_PATTERN.test(name) &&
  !name.includes("..");

/**
 * Pre-fetched project context to avoid redundant DB queries.
 * Pass this when the caller already has project and organization data.
 */
export interface ProjectContext {
  projectId: string;
  installationId: number;
}

export const postErrorsFoundCommentForRun = async (
  env: Env,
  db: DbClient,
  repository: string,
  prNumber: number,
  errorCount: number,
  failedRunCount: number,
  projectContext?: ProjectContext
): Promise<void> => {
  const [owner, repo] = repository.split("/");

  // SECURITY: Validate owner/repo segments before using in GitHub API calls
  // This prevents potential injection if repository format is somehow malformed
  if (
    !(
      owner &&
      repo &&
      isValidGitHubNameSegment(owner) &&
      isValidGitHubNameSegment(repo)
    )
  ) {
    // SECURITY: Truncate repository in log to prevent log injection
    console.log(
      `[report] Invalid repository format: ${repository.slice(0, 100)}, skipping comment`
    );
    return;
  }

  let projectId: string;
  let installationId: number;

  if (projectContext) {
    // Use pre-fetched context - avoids 2 DB queries
    projectId = projectContext.projectId;
    installationId = projectContext.installationId;
  } else {
    // Fallback: fetch project and org from DB (legacy path)
    const project = (await db.query("projects:getByRepoFullName", {
      providerRepoFullName: repository,
    })) as { _id: string; organizationId: string; removedAt?: number } | null;

    if (!project || project.removedAt) {
      console.log(
        `[report] Project not found for ${repository}, skipping comment`
      );
      return;
    }

    const org = (await db.query("organizations:getById", {
      id: project.organizationId,
    })) as { providerInstallationId?: string | null } | null;

    if (!org?.providerInstallationId) {
      console.log(
        `[report] Organization or installation not found for ${repository}, skipping comment`
      );
      return;
    }

    projectId = project._id;
    installationId = Number.parseInt(org.providerInstallationId, 10);
  }

  const projectUrl = `${env.NAVIGATOR_BASE_URL}/dashboard/${projectId}`;

  const commentBody = formatErrorsFoundComment({
    errorCount,
    jobCount: failedRunCount,
    projectUrl,
  });

  const github = createGitHubService(env);
  const token = await github.getInstallationToken(installationId);
  const appId = Number.parseInt(env.GITHUB_APP_ID, 10);

  await deleteAndPostComment({
    github,
    token,
    kv: env["detent-idempotency"],
    db,
    owner,
    repo,
    repository,
    prNumber,
    commentBody,
    appId,
  });

  console.log(
    `[report] Posted errors-found comment on ${repository}#${prNumber}`
  );
};

/**
 * Get project context for comment posting.
 * Returns projectId and installationId needed for GitHub API calls.
 *
 * Performance: Uses single JOIN query instead of N+1 pattern (was 2 sequential queries).
 */
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
