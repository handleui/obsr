import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../../db/client";
import {
  getOrgSettings,
  type OrganizationSettings,
  organizations,
  prComments,
  runErrors,
  runs,
} from "../../db/schema";
import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../../lib/cache";
import type { Env } from "../../types/env";
import type { ParsedError } from "../error-parser";
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
  errors: ParsedError[];
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

  const { db, client } = await createDb(env);
  const completedAt = new Date();

  try {
    await db.transaction(async (tx) => {
      // Bulk insert all runs in a single query
      const runRows = preparedRuns.map((data) => ({
        id: data.runRecordId,
        provider: "github" as const,
        source: "github",
        format: "github-actions",
        runId: String(data.runId),
        repository: data.repository,
        commitSha: data.headSha,
        prNumber: data.prNumber,
        checkRunId: data.checkRunId ? String(data.checkRunId) : null,
        errorCount: data.errors.length,
        workflowName: data.runName,
        conclusion: data.conclusion,
        headBranch: data.headBranch,
        runAttempt: data.runAttempt,
        runStartedAt: data.runStartedAt,
        runCompletedAt: completedAt,
      }));

      // Safety net: ON CONFLICT DO NOTHING handles rare race conditions
      // where two webhooks both pass KV/DB checks due to eventual consistency
      await tx.insert(runs).values(runRows).onConflictDoNothing();

      // Collect all errors from all runs into a single array for bulk insert
      const allErrorRows: Array<{
        id: string;
        runId: string;
        filePath: string | null;
        line: number | null;
        column: number | null;
        message: string;
        category: string | null;
        severity: string | null;
        ruleId: string | null;
        source: string | null;
        stackTrace: string | null;
        suggestions: string[] | null;
        hint: string | null;
        codeSnippet: {
          lines: string[];
          startLine: number;
          errorLine: number;
          language: string;
        } | null;
        workflowJob: string | null;
        workflowStep: string | null;
        workflowAction: string | null;
        unknownPattern: boolean | null;
        lineKnown: boolean | null;
        columnKnown: boolean | null;
        messageTruncated: boolean | null;
        stackTraceTruncated: boolean | null;
        exitCode: number | null;
        isInfrastructure: boolean | null;
        possiblyTestOutput: boolean | null;
      }> = [];

      for (const data of preparedRuns) {
        for (const error of data.errors) {
          allErrorRows.push({
            id: crypto.randomUUID(),
            runId: data.runRecordId,
            filePath: truncateString(error.filePath, MAX_FILE_PATH_LENGTH),
            line: validatePositiveInt(error.line, MAX_LINE_NUMBER),
            column: validatePositiveInt(error.column, MAX_COLUMN_NUMBER),
            message:
              truncateString(error.message, MAX_ERROR_MESSAGE_LENGTH) ??
              "Unknown error",
            category: truncateString(error.category, 100),
            severity: truncateString(error.severity, 50),
            ruleId: truncateString(error.ruleId, 200),
            source: truncateString(error.source, 100),
            stackTrace: truncateString(
              error.stackTrace,
              MAX_STACK_TRACE_LENGTH
            ),
            suggestions: error.suggestions ?? null,
            hint: truncateString(error.hint, MAX_ERROR_MESSAGE_LENGTH),
            codeSnippet: error.codeSnippet ?? null,
            workflowJob:
              truncateString(error.workflowJob, MAX_WORKFLOW_NAME_LENGTH) ??
              data.runName,
            workflowStep: truncateString(
              error.workflowStep,
              MAX_WORKFLOW_NAME_LENGTH
            ),
            workflowAction: truncateString(
              error.workflowAction,
              MAX_WORKFLOW_NAME_LENGTH
            ),
            unknownPattern: error.unknownPattern ?? null,
            lineKnown: error.lineKnown ?? null,
            columnKnown: error.columnKnown ?? null,
            messageTruncated: error.messageTruncated ?? null,
            stackTraceTruncated: error.stackTraceTruncated ?? null,
            exitCode: error.exitCode ?? null,
            isInfrastructure: error.isInfrastructure ?? null,
            possiblyTestOutput: error.possiblyTestOutput ?? null,
          });
        }
      }

      // Bulk insert all errors in a single query
      if (allErrorRows.length > 0) {
        await tx.insert(runErrors).values(allErrorRows);
      }
    });

    const totalErrors = preparedRuns.reduce(
      (sum, r) => sum + r.errors.length,
      0
    );
    console.log(
      `[workflow_run] Bulk stored ${preparedRuns.length} runs with ${totalErrors} total errors in single transaction`
    );
  } finally {
    await client.end();
  }
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

  const { db, client } = await createDb(env);
  try {
    // Execute both queries in parallel for better performance
    const [existingRunsResult, orgResult] = await Promise.all([
      // Query 1: Check existing run attempts
      runIdentifiers.length > 0
        ? db
            .select({
              runId: runs.runId,
              runAttempt: runs.runAttempt,
            })
            .from(runs)
            .where(
              and(
                eq(runs.repository, repository),
                inArray(
                  runs.runId,
                  runIdentifiers.map((r) => String(r.runId))
                )
              )
            )
        : Promise.resolve([]),

      // Query 2: Load org settings (skip if cached)
      cachedSettings
        ? Promise.resolve(null)
        : db.query.organizations.findFirst({
            where: eq(
              organizations.providerInstallationId,
              String(installationId)
            ),
            columns: { settings: true },
          }),
    ]);

    // Process run results
    const existingSet = new Set(
      existingRunsResult.map((r) => `${r.runId}:${r.runAttempt ?? 1}`)
    );
    const allExist =
      runIdentifiers.length === 0 ||
      runIdentifiers.every((r) =>
        existingSet.has(`${r.runId}:${r.runAttempt}`)
      );

    // Get org settings (from cache or DB result)
    let orgSettings: Required<OrganizationSettings>;
    if (cachedSettings) {
      orgSettings = getOrgSettings(cachedSettings);
    } else {
      const settings = orgResult?.settings ?? null;
      orgSettings = getOrgSettings(settings);
      // Cache the raw settings for future requests
      setInCache(settingsCacheKey, settings, CACHE_TTL.ORG_SETTINGS);
    }

    return { allExist, existingRuns: existingSet, orgSettings };
  } finally {
    await client.end();
  }
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
    const result = await db
      .select({ commentId: prComments.commentId })
      .from(prComments)
      .where(
        and(
          eq(prComments.repository, repository.toLowerCase()),
          eq(prComments.prNumber, prNumber)
        )
      )
      .limit(1);
    return result[0]?.commentId ?? null;
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
    // Single upsert query using ON CONFLICT DO UPDATE
    // Uses the unique index on (repository, prNumber) for conflict detection
    await db
      .insert(prComments)
      .values({
        id: crypto.randomUUID(),
        repository: normalizedRepo,
        prNumber,
        commentId,
      })
      .onConflictDoUpdate({
        target: [prComments.repository, prComments.prNumber],
        set: {
          commentId,
          updatedAt: new Date(),
        },
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
