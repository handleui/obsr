import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  createProviderSlug,
  getOrgSettings,
  type OrganizationSettings,
  organizationMembers,
  organizations,
  prComments,
  projects,
  runErrors,
  runs,
} from "../db/schema";
import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../lib/cache";
import { verifyGitHubMembership } from "../lib/github-membership";
import { captureWebhookError, type ParserContext } from "../lib/sentry";
import { webhookSignatureMiddleware } from "../middleware/webhook-signature";
import { deduplicatePrComments } from "../services/comment-dedup";
import {
  formatCheckRunOutput,
  formatPassingComment,
  formatResultsComment,
  formatWaitingComment,
  type WorkflowRunResult,
} from "../services/comment-formatter";
import {
  type ParsedError,
  parseWorkflowLogsWithFallback,
} from "../services/error-parser";
import { createGitHubService } from "../services/github";
import {
  acquireCommitLock,
  acquirePrCommentLock,
  getStoredCheckRunId,
  getStoredCommentId,
  releaseCommitLock,
  releasePrCommentLock,
  storeCheckRunId,
  storeCommentId,
} from "../services/idempotency";
import type { Env } from "../types/env";

// Type definitions for GitHub webhook payloads
interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    head_commit?: {
      message: string;
    };
    pull_requests: Array<{ number: number }>;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation: { id: number };
}

interface IssueCommentPayload {
  action: string;
  comment: {
    body: string;
    user: { login: string; type: string };
  };
  issue: {
    number: number;
    pull_request?: { url: string };
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation: { id: number };
}

interface PingPayload {
  zen: string;
  hook_id: number;
}

interface InstallationPayload {
  action:
    | "created"
    | "deleted"
    | "suspend"
    | "unsuspend"
    | "new_permissions_accepted";
  installation: {
    id: number;
    account: {
      id: number;
      login: string;
      type: "Organization" | "User";
      avatar_url?: string;
    };
  };
  // The user who triggered the webhook event (installer for "created" action)
  sender: {
    id: number;
    login: string;
    type: "User";
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
}

interface InstallationRepositoriesPayload {
  action: "added" | "removed";
  installation: {
    id: number;
    account: {
      id: number;
      login: string;
      type: "Organization" | "User";
    };
  };
  repositories_added: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
  repositories_removed: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
}

interface RepositoryPayload {
  action: "renamed" | "transferred" | "privatized" | "publicized";
  repository: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  };
  changes?: {
    repository?: {
      name?: { from: string };
    };
  };
  installation?: { id: number };
}

interface OrganizationPayload {
  action: "renamed" | "member_added" | "member_removed" | "member_invited";
  organization: {
    id: number;
    login: string;
    avatar_url?: string;
  };
  changes?: {
    login?: {
      from: string;
    };
  };
  installation?: { id: number };
}

interface CheckSuitePayload {
  action: "requested" | "rerequested" | "completed";
  check_suite: {
    id: number;
    head_sha: string;
    head_branch: string;
    head_commit?: {
      message: string;
    };
    pull_requests: Array<{ number: number; head: { sha: string } }>;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
    private?: boolean;
  };
  installation: { id: number };
}

interface DetentCommand {
  type: "status" | "help" | "unknown";
}

// Variables stored in context by middleware
interface WebhookVariables {
  webhookPayload:
    | WorkflowRunPayload
    | IssueCommentPayload
    | PingPayload
    | InstallationPayload
    | InstallationRepositoriesPayload
    | RepositoryPayload
    | OrganizationPayload
    | CheckSuitePayload;
}

type WebhookContext = Context<{ Bindings: Env; Variables: WebhookVariables }>;

const app = new Hono<{ Bindings: Env; Variables: WebhookVariables }>();

// GitHub webhook endpoint
// Receives: workflow_run, issue_comment, check_suite events
// Note: workflow_run.in_progress posts the "waiting" comment early when CI starts
app.post("/github", webhookSignatureMiddleware, (c: WebhookContext) => {
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");
  const payload = c.get("webhookPayload");

  console.log(`[webhook] Received ${event} event (delivery: ${deliveryId})`);

  // Route by event type
  switch (event) {
    case "workflow_run": {
      const workflowPayload = payload as WorkflowRunPayload;
      // Route based on action type
      if (workflowPayload.action === "in_progress") {
        return handleWorkflowRunInProgress(c, workflowPayload);
      }
      if (workflowPayload.action === "completed") {
        return handleWorkflowRunCompleted(c, workflowPayload);
      }
      // Ignore other actions (requested, etc.)
      return c.json({
        message: "ignored",
        reason: `action ${workflowPayload.action} not handled`,
      });
    }

    case "issue_comment":
      return handleIssueCommentEvent(c, payload as IssueCommentPayload);

    case "ping":
      // GitHub sends this when webhook is first configured
      return c.json({ message: "pong", zen: (payload as PingPayload).zen });

    case "installation":
      return handleInstallationEvent(c, payload as InstallationPayload);

    case "installation_repositories":
      return handleInstallationRepositoriesEvent(
        c,
        payload as InstallationRepositoriesPayload
      );

    case "repository":
      return handleRepositoryEvent(c, payload as RepositoryPayload);

    case "organization":
      return handleOrganizationEvent(c, payload as OrganizationPayload);

    case "check_suite":
      return handleCheckSuiteRequested(c, payload as CheckSuitePayload);

    default:
      console.log(`[webhook] Ignoring unhandled event: ${event}`);
      return c.json({ message: "ignored", event });
  }
});

// ParsedError is imported from ../services/error-parser

// ============================================================================
// Input Validation Helpers for GitHub Data
// ============================================================================
// Defense-in-depth: Validate GitHub API response data before database storage.
// While webhooks are signed, we validate data shapes and bounds to prevent
// issues from malformed responses or unexpected GitHub API changes.

// Maximum lengths for text fields to prevent database bloat
const MAX_WORKFLOW_NAME_LENGTH = 255;
const MAX_BRANCH_NAME_LENGTH = 255;
const MAX_CONCLUSION_LENGTH = 50;
const MAX_REPOSITORY_LENGTH = 200;
const MAX_ERROR_MESSAGE_LENGTH = 10_000;
const MAX_FILE_PATH_LENGTH = 1000;
const MAX_STACK_TRACE_LENGTH = 50_000;

// Validation ranges for numeric fields
const MAX_RUN_ID = Number.MAX_SAFE_INTEGER;
const MAX_PR_NUMBER = 1_000_000_000; // GitHub PR numbers are 32-bit integers

// SHA validation regex (40 hex characters)
const SHA_REGEX = /^[a-fA-F0-9]{40}$/;
const MAX_RUN_ATTEMPT = 10_000; // GitHub allows re-runs but has practical limits
const MAX_LINE_NUMBER = 10_000_000;
const MAX_COLUMN_NUMBER = 100_000;

/**
 * Validates and clamps a numeric value to safe bounds.
 * Returns null if the value is not a valid positive integer.
 */
const validatePositiveInt = (value: unknown, max: number): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, max);
};

/**
 * Truncates a string to maximum length, returning null for non-strings.
 */
const truncateString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

// Data structure for prepared run data (after validation)
interface PreparedRunData {
  runRecordId: string;
  runId: number;
  runName: string;
  prNumber: number;
  headSha: string;
  errors: ParsedError[];
  repository: string;
  checkRunId: number | null;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
}

/**
 * Validates run data and prepares it for database insertion.
 * Returns null if validation fails for critical fields.
 */
const prepareRunData = (data: {
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
const bulkStoreRunsAndErrors = async (
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
        hint: string | null;
        workflowJob: string | null;
        workflowStep: string | null;
        workflowAction: string | null;
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
            hint: truncateString(error.hint, MAX_ERROR_MESSAGE_LENGTH),
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

interface RunIdentifier {
  runId: number;
  runAttempt: number;
}

const checkRunsAndLoadOrgSettings = async (
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

type DbClient = Awaited<ReturnType<typeof createDb>>["db"];

/**
 * Retrieves a comment ID from the database for a PR.
 * Returns null if not found.
 */
const getCommentIdFromDb = async (
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
const upsertCommentIdInDb = async (
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

// ============================================================================
// Helper: Sanitize error messages for user-facing output
// ============================================================================
// Known safe error patterns that can be shown to users
const SAFE_ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /Invalid zip payload/i, message: "Invalid log archive format" },
  { pattern: /Zip archive contained no files/i, message: "Empty log archive" },
  {
    pattern: /Logs exceed maximum size/i,
    message: "Log files too large to process",
  },
  {
    pattern: /Zip archive.*exceed.*maximum size/i,
    message: "Log archive too large",
  },
  {
    pattern: /suspicious compression ratio/i,
    message: "Invalid log archive format",
  },
  {
    pattern: /too many files/i,
    message: "Log archive contains too many files",
  },
  {
    pattern: /Rate limit exceeded/i,
    message: "GitHub API rate limit exceeded",
  },
  { pattern: /Failed to fetch logs: 404/i, message: "Logs not available" },
  { pattern: /Failed to fetch logs: 403/i, message: "Log access denied" },
  {
    pattern: /Failed to fetch logs: 5\d{2}/i,
    message: "GitHub API unavailable",
  },
];

const sanitizeErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "An unexpected error occurred";
  }

  const message = error.message;

  // Check against known safe patterns
  for (const { pattern, message: safeMessage } of SAFE_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return safeMessage;
    }
  }

  // For unknown errors, return a generic message to avoid leaking internal details
  // The full error is logged to console for debugging
  return "An internal error occurred while processing logs";
};

// ============================================================================
// Error codes for webhook processing - helps with debugging and correlation
// ============================================================================
// Each error code identifies a specific failure category for easier diagnosis.
// Format: WEBHOOK_<EVENT>_<CATEGORY> (e.g., WEBHOOK_WORKFLOW_TOKEN_FAILED)
export const ERROR_CODES = {
  // Token/auth errors
  TOKEN_FAILED: "WEBHOOK_TOKEN_FAILED",

  // GitHub API errors
  GITHUB_RATE_LIMIT: "WEBHOOK_GITHUB_RATE_LIMIT",
  GITHUB_NOT_FOUND: "WEBHOOK_GITHUB_NOT_FOUND",
  GITHUB_API_ERROR: "WEBHOOK_GITHUB_API_ERROR",

  // Database errors
  DB_CONNECTION: "WEBHOOK_DB_CONNECTION",

  // Workflow processing errors
  WORKFLOW_LOG_FETCH: "WEBHOOK_WORKFLOW_LOG_FETCH",
  WORKFLOW_VALIDATION: "WEBHOOK_WORKFLOW_VALIDATION",

  // Generic errors
  UNKNOWN: "WEBHOOK_UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

interface ClassifiedError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

// ============================================================================
// Helper: Classify and sanitize error for API responses
// ============================================================================
// Returns a structured error with:
// - code: Machine-readable error code for programmatic handling
// - message: Human-readable description (sanitized for security)
// - hint: Optional troubleshooting suggestion
//
// Prevents leaking internal implementation details (e.g., database connection
// strings, file paths, stack traces) in error responses.
// Helper: Detect which resource is not found from error message
const detectNotFoundResource = (message: string): string => {
  if (message.includes("repository")) {
    return "repository";
  }
  if (message.includes("check run")) {
    return "check run";
  }
  if (message.includes("comment")) {
    return "comment";
  }
  if (message.includes("workflow")) {
    return "workflow run";
  }
  if (message.includes("pull request") || message.includes("pr")) {
    return "pull request";
  }
  return "resource";
};

// Helper: Check if message indicates token/auth error
const isTokenError = (message: string): boolean =>
  message.includes("installation token") ||
  message.includes("bad credentials") ||
  message.includes("authentication");

// Helper: Check if message indicates database error
// Note: Avoid provider-specific identifiers to prevent implementation leakage
const isDatabaseError = (message: string): boolean =>
  message.includes("database") ||
  (message.includes("connection") && !message.includes("github")) ||
  message.includes("econnrefused") ||
  message.includes("sql");

// Helper: Check if message indicates GitHub API error
const isGitHubApiError = (message: string): boolean =>
  message.includes("github api") || message.includes("octokit");

const classifyError = (error: unknown): ClassifiedError => {
  if (!(error instanceof Error)) {
    return {
      code: ERROR_CODES.UNKNOWN,
      message: "An unexpected error occurred",
      hint: "Check server logs with the delivery ID for details",
    };
  }

  const message = error.message.toLowerCase();

  // Token/auth errors
  if (isTokenError(message)) {
    return {
      code: ERROR_CODES.TOKEN_FAILED,
      message: "Failed to authenticate with GitHub",
      hint: "The GitHub App installation may be suspended or the app needs to be reinstalled",
    };
  }

  // Rate limiting
  if (message.includes("rate limit")) {
    return {
      code: ERROR_CODES.GITHUB_RATE_LIMIT,
      message: "GitHub API rate limit exceeded",
      hint: "Wait a few minutes and retry, or check for excessive API calls",
    };
  }

  // Not found errors
  if (message.includes("not found") || message.includes("404")) {
    const resource = detectNotFoundResource(message);
    return {
      code: ERROR_CODES.GITHUB_NOT_FOUND,
      message: `${resource.charAt(0).toUpperCase() + resource.slice(1)} not found`,
      hint: `The ${resource} may have been deleted, or the app may not have access`,
    };
  }

  // Database errors
  if (isDatabaseError(message)) {
    return {
      code: ERROR_CODES.DB_CONNECTION,
      message: "Database connection error",
      hint: "Transient database issue - webhook will be retried automatically",
    };
  }

  // Log fetching errors
  if (message.includes("fetch") && message.includes("log")) {
    return {
      code: ERROR_CODES.WORKFLOW_LOG_FETCH,
      message: "Failed to fetch workflow logs",
      hint: "GitHub may be experiencing issues, or logs may have expired",
    };
  }

  // Validation errors (safe to expose)
  if (message.includes("[workflow_run] invalid")) {
    return {
      code: ERROR_CODES.WORKFLOW_VALIDATION,
      message: error.message.slice(0, 200),
    };
  }

  // GitHub API errors (generic)
  if (isGitHubApiError(message)) {
    return {
      code: ERROR_CODES.GITHUB_API_ERROR,
      message: "GitHub API request failed",
      hint: "Check GitHub status page or retry the webhook",
    };
  }

  // Default: unknown error
  return {
    code: ERROR_CODES.UNKNOWN,
    message: "An internal error occurred",
    hint: "Check server logs with the delivery ID for details",
  };
};

// ============================================================================
// Helper: Process and store ALL runs with bulk database operations
// ============================================================================
//
// Stores ALL workflow runs (not just failures) for comprehensive tracking.
// - Failed runs: fetch logs, parse errors, store with errors
// - Other runs: store with metadata only (no errors)
//
// Performance optimizations (Cloudflare Workers - 128MB memory, 6 TCP connections):
// - Fetches logs in parallel batches (MAX_CONCURRENT_FETCHES) to reduce latency
// - Parses logs immediately after fetch to free memory before next batch
// - BULK INSERTS: All runs stored in single transaction (1 connection, not N)
// - Reduces DB round-trips from 2N to 2 (one INSERT for runs, one for errors)

// Run metadata from GitHub API
interface WorkflowRunMeta {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
  event: string;
}

const processAndStoreAllRuns = async (
  env: Env,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  allRuns: WorkflowRunMeta[],
  context: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    repository: string;
    checkRunId: number;
  }
): Promise<{
  errors: ParsedError[];
  detectedUnsupportedTools: string[];
  parserContext?: ParserContext;
}> => {
  // Limit concurrent fetches to avoid memory pressure from multiple ZIP files
  // Each workflow log can be up to 30MB compressed, so we keep this conservative
  const MAX_CONCURRENT_FETCHES = 3;

  const allErrors: ParsedError[] = [];
  const allUnsupportedTools = new Set<string>();
  const failedRuns = allRuns.filter((r) => r.conclusion === "failure");

  // Map to store errors by run ID
  const errorsByRunId = new Map<number, ParsedError[]>();

  // Track aggregated parser context for Sentry error reporting
  let aggregatedLogBytes = 0;
  let aggregatedJobCount = 0;
  let aggregatedErrorCount = 0;
  let parsersAvailable: string[] = [];

  // Process a single failed run: fetch logs, parse, and return errors
  const processFailedRun = async (run: WorkflowRunMeta): Promise<void> => {
    try {
      // Fetch logs from GitHub API
      const logsResult = await github.fetchWorkflowLogs(
        token,
        context.owner,
        context.repo,
        run.id
      );

      // Parse logs and extract errors (with fallback if none found)
      const parseResult = parseWorkflowLogsWithFallback(
        logsResult.logs,
        run.name,
        {
          totalBytes: logsResult.totalBytes,
          jobCount: logsResult.jobCount,
        }
      );

      // Attach workflow context to each error
      const errorsWithContext = parseResult.errors.map((e) => ({
        ...e,
        workflowJob: e.workflowJob ?? run.name,
      }));

      // Collect unsupported tools
      for (const tool of parseResult.detectedUnsupportedTools) {
        allUnsupportedTools.add(tool);
      }

      // Aggregate parser context for Sentry error reporting
      aggregatedLogBytes += parseResult.parserContext.logBytes;
      aggregatedJobCount += parseResult.parserContext.jobCount;
      aggregatedErrorCount += parseResult.parserContext.errorCount;
      if (parsersAvailable.length === 0) {
        parsersAvailable = parseResult.parserContext.parsersAvailable;
      }

      console.log(
        `[workflow_run] Parsed ${errorsWithContext.length} errors from run ${run.id} (${run.name})`
      );

      errorsByRunId.set(run.id, errorsWithContext);
      allErrors.push(...errorsWithContext);
    } catch (error) {
      // If log fetching/parsing fails, use a fallback error
      console.error(
        `[workflow_run] Failed to fetch/parse logs for run ${run.id}:`,
        error
      );

      // Sanitize error message for user-facing output (avoid leaking internal details)
      const sanitizedMessage = sanitizeErrorMessage(error);
      const fallbackError: ParsedError = {
        message: `Workflow "${run.name}" failed. Unable to fetch logs: ${sanitizedMessage}`,
        category: "workflow",
        severity: "error",
        source: "github-actions",
        workflowJob: run.name,
      };

      errorsByRunId.set(run.id, [fallbackError]);
      allErrors.push(fallbackError);
    }
  };

  // Fetch and parse logs for failed runs in parallel batches
  for (let i = 0; i < failedRuns.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = failedRuns.slice(i, i + MAX_CONCURRENT_FETCHES);
    await Promise.all(batch.map(processFailedRun));
  }

  // Prepare all runs for bulk storage (validates and sanitizes data)
  const preparedRuns: PreparedRunData[] = [];
  for (const run of allRuns) {
    const prepared = prepareRunData({
      runId: run.id,
      runName: run.name,
      prNumber: context.prNumber,
      headSha: context.headSha,
      errors: errorsByRunId.get(run.id) ?? [],
      repository: context.repository,
      checkRunId: context.checkRunId,
      conclusion: run.conclusion,
      headBranch: run.headBranch,
      runAttempt: run.runAttempt,
      runStartedAt: run.runStartedAt,
    });
    if (prepared) {
      preparedRuns.push(prepared);
    }
  }

  // Bulk store all runs in a single transaction for efficiency
  await bulkStoreRunsAndErrors(env, preparedRuns);

  // Build aggregated parser context if any runs were successfully parsed
  const parserContext: ParserContext | undefined =
    aggregatedLogBytes > 0
      ? {
          logBytes: aggregatedLogBytes,
          jobCount: aggregatedJobCount,
          errorCount: aggregatedErrorCount,
          parsersAvailable,
          detectedUnsupportedTools: [...allUnsupportedTools].sort(),
        }
      : undefined;

  return {
    errors: allErrors,
    detectedUnsupportedTools: [...allUnsupportedTools].sort(),
    parserContext,
  };
};

// ============================================================================
// Helper: Clean up check run on error (prevents stale "in progress" state)
// ============================================================================
const cleanupCheckRunOnError = async (
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  context?: { deliveryId?: string; error?: unknown }
): Promise<void> => {
  const classified = context?.error
    ? classifyError(context.error)
    : { code: ERROR_CODES.UNKNOWN, message: "Unknown error" };
  const deliveryId = context?.deliveryId ?? "unknown";

  try {
    await github.updateCheckRun(token, {
      owner,
      repo,
      checkRunId,
      status: "completed",
      conclusion: "cancelled",
      output: {
        title: `Analysis failed: ${classified.code}`,
        summary: [
          `**Error:** ${classified.message}`,
          "",
          classified.hint ? `**Hint:** ${classified.hint}` : "",
          "",
          "---",
          `**Delivery ID:** \`${deliveryId}\``,
          "",
          "Use the delivery ID to correlate with server logs for detailed debugging.",
          "This webhook may be automatically retried by GitHub.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    });
    console.log(
      `[workflow_run] Cleaned up check run ${checkRunId} after error [delivery: ${deliveryId}]`
    );
  } catch (cleanupError) {
    console.error(
      `[workflow_run] Failed to clean up check run ${checkRunId}:`,
      cleanupError
    );
  }
};

// ============================================================================
// Helper: Attempt check run cleanup with token recovery
// ============================================================================
// When errors occur, try to clean up the check run to avoid orphaned "queued" state.
// If token isn't available, attempt to recover it first.
const attemptCheckRunCleanup = async (
  github: ReturnType<typeof createGitHubService>,
  token: string | undefined,
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  deliveryId: string,
  originalError?: unknown
): Promise<void> => {
  const errorContext = { deliveryId, error: originalError };

  if (token) {
    await cleanupCheckRunOnError(
      github,
      token,
      owner,
      repo,
      checkRunId,
      errorContext
    );
    return;
  }

  // Token failed to obtain - try to get it again for cleanup
  console.log(
    `[workflow_run] Attempting token recovery for check run cleanup [delivery: ${deliveryId}]`
  );
  try {
    const recoveryToken = await github.getInstallationToken(installationId);
    await cleanupCheckRunOnError(
      github,
      recoveryToken,
      owner,
      repo,
      checkRunId,
      errorContext
    );
  } catch (tokenError) {
    console.error(
      `[workflow_run] Failed to recover token for cleanup, check run ${checkRunId} may be orphaned [delivery: ${deliveryId}]:`,
      tokenError
    );
  }
};

// ============================================================================
// Helper: Handle early return when no PR is associated with workflow run
// ============================================================================
// Cleans up any orphaned check run and releases the commit lock before returning.
const handleNoPrEarlyReturn = async (
  github: ReturnType<typeof createGitHubService>,
  token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    runId: number;
    deliveryId: string;
    storedCheckRunId: number | null;
  }
): Promise<{
  message: string;
  repository: string;
  runId: number;
  status: string;
}> => {
  const {
    installationId,
    owner,
    repo,
    repository,
    headSha,
    runId,
    deliveryId,
    storedCheckRunId,
  } = context;

  console.log("[workflow_run] No associated PR found, skipping");

  // Clean up any existing check run since we won't process this
  if (storedCheckRunId) {
    await attemptCheckRunCleanup(
      github,
      token,
      installationId,
      owner,
      repo,
      storedCheckRunId,
      deliveryId
    );
  }

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "workflow_run processed",
    repository,
    runId,
    status: "no_pr",
  };
};

// ============================================================================
// Helper: Handle early return when waiting for other runs to complete
// ============================================================================
// Releases the commit lock but preserves the check run in "queued" state.
// The check run will be finalized when all workflows complete.
const handleWaitingForRunsEarlyReturn = async (
  _github: ReturnType<typeof createGitHubService>,
  _token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    deliveryId: string;
    storedCheckRunId: number | null;
    completedCount: number;
    pendingCount: number;
  }
): Promise<{
  message: string;
  repository: string;
  completed: number;
  pending: number;
}> => {
  const { repository, headSha, completedCount, pendingCount } = context;

  console.log(
    `[workflow_run] Waiting for ${pendingCount} more runs to complete`
  );

  // NOTE: Do NOT clean up the check run here. It should remain in "queued" state
  // and will be properly finalized when all workflows complete. Cleaning it up
  // here would mark it as "cancelled" prematurely.

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "waiting for other runs",
    repository,
    completed: completedCount,
    pending: pendingCount,
  };
};

// ============================================================================
// Helper: Handle early return when all runs already processed (duplicate)
// ============================================================================
// Releases the commit lock. The check run was already finalized by the original
// processing, so we don't touch it.
const handleAllRunsProcessedEarlyReturn = async (
  _github: ReturnType<typeof createGitHubService>,
  _token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    deliveryId: string;
    storedCheckRunId: number | null;
    runCount: number;
  }
): Promise<{
  message: string;
  repository: string;
  headSha: string;
  status: string;
}> => {
  const { repository, headSha, deliveryId, runCount } = context;

  console.log(
    `[workflow_run] All ${runCount} run attempts already stored, skipping [delivery: ${deliveryId}]`
  );

  // NOTE: Do NOT clean up the check run here. All runs were already processed,
  // which means the check run was already finalized (completed with success or
  // failure) by the original webhook. Cleaning it up would wrongly overwrite
  // that result with "cancelled".

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "already processed (db check)",
    repository,
    headSha,
    status: "duplicate_db",
  };
};

// ============================================================================
// Helper: Post or update PR comment with deduplication
// ============================================================================
// Handles the comment lifecycle: check KV → check DB → update or create → persist
// Includes 404 recovery if comment was deleted by user

interface PostCommentContext {
  github: ReturnType<typeof createGitHubService>;
  token: string;
  kv: KVNamespace;
  db: DbClient;
  executionCtx?: ExecutionContext;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  commentBody: string;
  appId: number;
}

const postOrUpdateComment = async (ctx: PostCommentContext): Promise<void> => {
  const { kv, db, repository, prNumber } = ctx;

  // Check KV first (fast path), then DB (persistent fallback)
  let existingCommentId = await getStoredCommentId(kv, repository, prNumber);
  let commentSource = "kv";

  if (!existingCommentId) {
    const dbCommentId = await getCommentIdFromDb(db, repository, prNumber);
    if (dbCommentId) {
      existingCommentId = Number.parseInt(dbCommentId, 10);
      commentSource = "db";
      console.log(
        `[workflow_run] Found comment ID ${existingCommentId} in DB (KV miss) for PR #${prNumber}`
      );
    }
  }

  if (existingCommentId) {
    await updateExistingComment(ctx, existingCommentId, commentSource);
  } else {
    await createNewComment(ctx);
  }
};

const updateExistingComment = async (
  ctx: PostCommentContext,
  commentId: number,
  source: string
): Promise<void> => {
  const { github, token, kv, owner, repo, repository, prNumber, commentBody } =
    ctx;

  try {
    await github.updateComment(token, owner, repo, commentId, commentBody);
    console.log(
      `[workflow_run] Updated existing comment ${commentId} on PR #${prNumber} (source: ${source})`
    );
    // Refresh KV cache if found in DB
    if (source === "db") {
      await storeCommentId(kv, repository, prNumber, commentId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFound =
      errorMessage.includes("404") || errorMessage.includes("not found");

    if (isNotFound) {
      // Comment was deleted externally - create a new one.
      // This is safe because the PR comment lock is held by finalizeAndPostResults.
      // Note: KV locks are eventually consistent, so very rare duplicate comments
      // are possible if two webhooks win the lock race. The DB stores the latest
      // comment ID, so subsequent updates will consolidate to one comment.
      console.log(
        `[workflow_run] Comment ${commentId} was deleted, creating new comment for PR #${prNumber}`
      );
      await createNewComment(ctx);
    } else {
      throw error;
    }
  }
};

const createNewComment = async (ctx: PostCommentContext): Promise<void> => {
  const {
    github,
    token,
    kv,
    db,
    executionCtx,
    owner,
    repo,
    repository,
    prNumber,
    commentBody,
    appId,
  } = ctx;

  const { id: newCommentId } = await github.postCommentWithId(
    token,
    owner,
    repo,
    prNumber,
    commentBody
  );
  // Store in both KV (cache) and DB (persistence)
  await storeCommentId(kv, repository, prNumber, newCommentId);
  await upsertCommentIdInDb(db, repository, prNumber, String(newCommentId));
  console.log(
    `[workflow_run] Posted new comment ${newCommentId} on PR #${prNumber}`
  );
  if (Number.isInteger(appId) && appId > 0) {
    const dedupTask = deduplicatePrComments({
      token,
      owner,
      repo,
      prNumber,
      storedCommentId: newCommentId,
      appId,
    }).catch((error) => {
      console.error("[dedup] Failed:", error);
    });

    if (executionCtx) {
      executionCtx.waitUntil(dedupTask);
    }
  }
};

// ============================================================================
// Helper: Update existing comment to passing state
// ============================================================================
// When all checks pass, update any existing failure comment to show success
// Only updates if a comment already exists (no new comment created for passing)

interface UpdatePassingCommentContext {
  github: ReturnType<typeof createGitHubService>;
  token: string;
  kv: KVNamespace;
  db: DbClient;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  headSha: string;
  /** First line of the commit message */
  headCommitMessage?: string;
  runs: WorkflowRunResult[];
}

const updateCommentToPassingState = async (
  ctx: UpdatePassingCommentContext
): Promise<boolean> => {
  const {
    github,
    token,
    kv,
    db,
    owner,
    repo,
    repository,
    prNumber,
    headSha,
    headCommitMessage,
    runs,
  } = ctx;

  // Check KV first (fast path)
  let existingCommentId = await getStoredCommentId(kv, repository, prNumber);

  // Fall back to DB if not in KV
  if (!existingCommentId) {
    const dbCommentId = await getCommentIdFromDb(db, repository, prNumber);
    if (dbCommentId) {
      existingCommentId = Number.parseInt(dbCommentId, 10);
    }
  }

  // No existing comment = PR never had failures, nothing to update
  if (!existingCommentId) {
    console.log(
      `[workflow_run] All checks passed - no existing comment to update for PR #${prNumber}`
    );
    return false;
  }

  // Format and update the comment to passing state
  const passingBody = formatPassingComment({
    runs,
    headSha,
    headCommitMessage,
  });

  try {
    await github.updateComment(
      token,
      owner,
      repo,
      existingCommentId,
      passingBody
    );
    console.log(
      `[workflow_run] Updated comment ${existingCommentId} to passing state for PR #${prNumber}`
    );
    return true;
  } catch (error) {
    // Comment may have been deleted - that's fine, no need to recreate for passing state
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFound =
      errorMessage.includes("404") || errorMessage.includes("not found");
    if (isNotFound) {
      console.log(
        `[workflow_run] Comment ${existingCommentId} was deleted, skipping passing comment for PR #${prNumber}`
      );
      return false;
    }
    throw error;
  }
};

// ============================================================================
// Helper: Finalize check run and post PR comment with results
// ============================================================================
interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

const finalizeAndPostResults = async (
  env: Env,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  kv: KVNamespace,
  context: {
    owner: string;
    repo: string;
    repository: string;
    executionCtx: ExecutionContext;
    headSha: string;
    headCommitMessage?: string;
    prNumber: number;
    checkRunId: number;
    workflowRuns: WorkflowRun[];
    allErrors: ParsedError[];
    detectedUnsupportedTools: string[];
    // Feature settings
    enableInlineAnnotations: boolean;
    enablePrComments: boolean;
  }
): Promise<{
  runResults: Array<{
    name: string;
    id: number;
    conclusion: string;
    errorCount: number;
  }>;
  totalErrors: number;
}> => {
  const {
    owner,
    repo,
    repository,
    executionCtx,
    headSha,
    headCommitMessage,
    prNumber,
    checkRunId,
    workflowRuns,
    allErrors,
    detectedUnsupportedTools,
    enableInlineAnnotations,
    enablePrComments,
  } = context;

  // Prepare run results for formatting
  const runResults = workflowRuns.map((r) => ({
    name: r.name,
    id: r.id,
    conclusion: r.conclusion ?? "unknown",
    errorCount: allErrors.filter((e) => e.workflowJob === r.name).length,
  }));

  const failedCount = workflowRuns.filter(
    (r) => r.conclusion === "failure"
  ).length;
  const hasFailed = failedCount > 0;
  const totalErrors = allErrors.length;

  // Format check run output with summary, error details, and inline annotations
  const checkRunOutput = formatCheckRunOutput({
    owner,
    repo,
    headSha,
    runs: runResults,
    errors: allErrors,
    totalErrors,
    detectedUnsupportedTools,
  });

  // Update check run to completed
  await github.updateCheckRun(token, {
    owner,
    repo,
    checkRunId,
    status: "completed",
    conclusion: hasFailed ? "neutral" : "success",
    output: {
      title: hasFailed
        ? `${totalErrors} error${totalErrors !== 1 ? "s" : ""} found`
        : "All checks passed",
      summary: checkRunOutput.summary,
      text: checkRunOutput.text,
      // Only include annotations if enabled in org settings
      ...(enableInlineAnnotations && {
        annotations: checkRunOutput.annotations,
      }),
    },
  });

  // Skip PR comments if disabled in org settings
  if (!enablePrComments) {
    console.log(`[webhook] PR comments disabled for ${repository}`);
    return { runResults, totalErrors };
  }

  // Create DB connection (needed for both passing and failing cases)
  const { db, client } = await createDb(env);
  let lockAcquired = false;

  try {
    // When all checks pass, update existing comment to "passing" state
    // (only if a previous failure comment exists)
    if (!hasFailed) {
      const prLock = await acquirePrCommentLock(kv, repository, prNumber);
      if (!prLock.acquired) {
        console.log(
          `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber}, skipping passing comment update`
        );
        return { runResults, totalErrors };
      }
      lockAcquired = true;

      await updateCommentToPassingState({
        github,
        token,
        kv,
        db,
        owner,
        repo,
        repository,
        prNumber,
        headSha,
        headCommitMessage,
        runs: runResults,
      });

      return { runResults, totalErrors };
    }

    // When checks fail, post or update the failure comment
    // Acquire PR comment lock to prevent race conditions
    // Note: KV locks are eventually consistent, so rare race conditions are possible.
    // The DB unique constraint on prComments table is the ultimate safety net.
    const prLock = await acquirePrCommentLock(kv, repository, prNumber);
    if (!prLock.acquired) {
      console.log(
        `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber}, skipping comment`
      );
      return { runResults, totalErrors };
    }
    lockAcquired = true;

    const commentBody = formatResultsComment({
      owner,
      repo,
      headSha,
      headCommitMessage,
      runs: runResults,
      errors: allErrors,
      totalErrors,
      detectedUnsupportedTools,
      checkRunId,
    });

    // Safety: formatResultsComment returns null if no failures
    // This shouldn't happen since we check hasFailed above, but handle gracefully
    if (!commentBody) {
      console.log(
        `[workflow_run] No comment body generated for PR #${prNumber}, skipping`
      );
      return { runResults, totalErrors };
    }

    const appId = Number.parseInt(env.GITHUB_APP_ID, 10);
    await postOrUpdateComment({
      github,
      token,
      kv,
      db,
      executionCtx,
      owner,
      repo,
      repository,
      prNumber,
      commentBody,
      appId,
    });
  } finally {
    await client.end();
    if (lockAcquired) {
      await releasePrCommentLock(kv, repository, prNumber);
    }
  }

  return { runResults, totalErrors };
};

// Handle workflow_run.in_progress - create a "queued" check run to show users we're watching
const handleWorkflowRunInProgress = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] In progress: ${repository.full_name} / ${workflow_run.name} [delivery: ${deliveryId}]`
  );

  // Check if we already created a check run for this commit
  const existingCheckRunId = await getStoredCheckRunId(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );

  if (existingCheckRunId) {
    console.log(
      `[workflow_run] Check run ${existingCheckRunId} already exists for ${headSha.slice(0, 7)}`
    );
    return c.json({
      message: "check run already exists",
      checkRunId: existingCheckRunId,
    });
  }

  const github = createGitHubService(c.env);

  try {
    const token = await github.getInstallationToken(installation.id);

    // Get PR number from payload, or try commits API for fork PRs
    let prNumber = workflow_run.pull_requests[0]?.number;
    if (!prNumber) {
      // For fork PRs, workflow_run.pull_requests is empty but commits API works
      prNumber =
        (await github.getPullRequestForCommit(token, owner, repo, headSha)) ??
        undefined;
    }

    // Skip if no PR associated (e.g., push to main branch)
    if (!prNumber) {
      console.log(
        `[workflow_run] No PR associated with ${workflow_run.name}, skipping [delivery: ${deliveryId}]`
      );
      return c.json({
        message: "skipped",
        reason: "no_pr",
        branch: workflow_run.head_branch,
      });
    }

    // Create a "queued" check run so users know we're watching
    const checkRun = await github.createCheckRun(token, {
      owner,
      repo,
      headSha,
      name: "Detent Parser",
      status: "queued",
      output: {
        title: "Waiting for CI to complete...",
        summary: "Detent will analyze CI results once all workflows finish.",
      },
    });

    // Store the check run ID for later update
    await storeCheckRunId(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha,
      checkRun.id
    );

    console.log(
      `[workflow_run] Created queued check run ${checkRun.id} for ${headSha.slice(0, 7)}`
    );

    // Post waiting comment in background (non-blocking for faster webhook response)
    // The postWaitingComment function handles idempotency - won't post if comment exists
    c.executionCtx.waitUntil(
      postWaitingComment({
        env: c.env,
        token,
        owner,
        repo,
        repository: repository.full_name,
        prNumber,
        headSha,
        headCommitMessage: workflow_run.head_commit?.message,
      })
    );

    return c.json({
      message: "check run created",
      checkRunId: checkRun.id,
      status: "queued",
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error creating queued check run [delivery: ${deliveryId}]:`,
      error
    );
    // Non-fatal - we'll create the check run on completed if this fails
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "workflow_run.in_progress",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
      workflowName: workflow_run.name,
      runId: workflow_run.id,
    });
    return c.json({
      message: "failed to create check run",
      errorCode: classified.code,
      error: classified.message,
      hint: classified.hint,
      deliveryId,
      repository: repository.full_name,
    });
  }
};

// Handle workflow_run events (CI completed)
// Waits for ALL workflow runs for a commit to complete before posting comment
//
// Robustness features:
// - Idempotency: Uses KV-backed lock to prevent duplicate processing (survives Worker restarts)
// - Race condition handling: Returns early if another webhook is processing
// - Error recovery: Cleans up check run on failure (retrieves stored ID early)
// - Database-backed deduplication: Unique constraint on (repository, commitSha, runId)
const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
  const headCommitMessage = workflow_run.head_commit?.message;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[workflow_run] Completed: ${repository.full_name} / ${workflow_run.name} (${workflow_run.conclusion}) [delivery: ${deliveryId}]`
  );

  // Idempotency check: Prevent duplicate processing of same commit (KV-backed)
  const lockResult = await acquireCommitLock(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );
  if (!lockResult.acquired) {
    const state = lockResult.state;
    const status = state?.processing
      ? "duplicate_in_progress"
      : "duplicate_completed";
    console.log(
      `[workflow_run] Commit ${headSha.slice(0, 7)} ${state?.processing ? "already being processed" : "already processed"}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: state?.processing ? "already processing" : "already processed",
      repository: repository.full_name,
      headSha,
      checkRunId: state?.checkRunId,
      status,
    });
  }

  const github = createGitHubService(c.env);
  let checkRunId: number | undefined;
  let token: string | undefined;
  let parserContext: ParserContext | undefined;

  // IMPORTANT: Retrieve stored check run ID early for error recovery
  // This ensures we can clean up the check run if errors occur before we
  // would normally fetch it. Without this, check runs can get stuck as "queued" forever.
  const storedCheckRunIdForRecovery = await getStoredCheckRunId(
    c.env["detent-idempotency"],
    repository.full_name,
    headSha
  );
  if (storedCheckRunIdForRecovery) {
    console.log(
      `[workflow_run] Found stored check run ${storedCheckRunIdForRecovery} for recovery [delivery: ${deliveryId}]`
    );
  }

  try {
    token = await github.getInstallationToken(installation.id);

    // Get PR number (skip if no PR associated)
    // For fork PRs, workflow_run.pull_requests is empty but commits API works
    const prFromPayload = workflow_run.pull_requests[0]?.number;
    const prNumber =
      prFromPayload ??
      (await github.getPullRequestForCommit(token, owner, repo, headSha));

    if (!prNumber) {
      return c.json(
        await handleNoPrEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            runId: workflow_run.id,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
          }
        )
      );
    }

    // Check if ALL workflow runs for this commit are done BEFORE creating check run
    const { allCompleted, runs: workflowRuns } =
      await github.listWorkflowRunsForCommit(token, owner, repo, headSha);

    if (!allCompleted) {
      const pendingCount = workflowRuns.filter(
        (r) => r.status !== "completed"
      ).length;
      return c.json(
        await handleWaitingForRunsEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
            completedCount: workflowRuns.filter((r) => r.status === "completed")
              .length,
            pendingCount,
          }
        )
      );
    }

    // Run-aware idempotency: check which specific (runId, runAttempt) tuples exist
    // This enables proper re-run handling - same runId with different runAttempt is a new run
    // Performance: Also loads org settings in same DB connection (with caching)
    const runIdentifiers = workflowRuns.map((r) => ({
      runId: r.id,
      runAttempt: r.runAttempt,
    }));

    const { allExist, existingRuns, orgSettings } =
      await checkRunsAndLoadOrgSettings(
        c.env,
        repository.full_name,
        runIdentifiers,
        installation.id
      );

    if (allExist) {
      return c.json(
        await handleAllRunsProcessedEarlyReturn(
          github,
          token,
          c.env["detent-idempotency"],
          {
            installationId: installation.id,
            owner,
            repo,
            repository: repository.full_name,
            headSha,
            deliveryId,
            storedCheckRunId: storedCheckRunIdForRecovery,
            runCount: runIdentifiers.length,
          }
        )
      );
    }

    // Filter to only runs that need processing (re-runs will pass through)
    const runsToProcess = workflowRuns.filter(
      (r) => !existingRuns.has(`${r.id}:${r.runAttempt}`)
    );

    console.log(
      `[workflow_run] Processing ${runsToProcess.length} new runs (${existingRuns.size} already stored)`
    );

    // All runs completed! Get or create check run
    // Use the check run ID we retrieved early for error recovery
    if (storedCheckRunIdForRecovery) {
      // Update existing check run to in_progress
      checkRunId = storedCheckRunIdForRecovery;
      await github.updateCheckRun(token, {
        owner,
        repo,
        checkRunId,
        status: "in_progress",
        output: {
          title: "Analyzing CI results...",
          summary: "Processing workflow runs and extracting errors",
        },
      });
      console.log(
        `[workflow_run] Updated existing check run ${checkRunId} to in_progress`
      );
    } else {
      // No existing check run - create one (fallback if in_progress handler didn't run)
      const checkRun = await github.createCheckRun(token, {
        owner,
        repo,
        headSha,
        name: "Detent Parser",
        status: "in_progress",
        output: {
          title: "Analyzing CI results...",
          summary: "Processing workflow runs and extracting errors",
        },
      });
      checkRunId = checkRun.id;
      console.log(`[workflow_run] Created new check run ${checkRunId}`);
    }

    // At this point checkRunId is guaranteed to be set
    const finalCheckRunId = checkRunId;

    // Process only NEW runs: fetch logs for failures, store with metadata
    // Re-runs (same runId, different runAttempt) will be in runsToProcess
    const {
      errors: allErrors,
      detectedUnsupportedTools,
      parserContext: processedParserContext,
    } = await processAndStoreAllRuns(c.env, github, token, runsToProcess, {
      owner,
      repo,
      prNumber,
      headSha,
      repository: repository.full_name,
      checkRunId: finalCheckRunId,
    });
    parserContext = processedParserContext;

    // Finalize: update check run and post PR comment (if failures)
    const { totalErrors } = await finalizeAndPostResults(
      c.env,
      github,
      token,
      c.env["detent-idempotency"],
      {
        owner,
        repo,
        repository: repository.full_name,
        executionCtx: c.executionCtx,
        headSha,
        headCommitMessage,
        prNumber,
        checkRunId: finalCheckRunId,
        workflowRuns,
        allErrors,
        detectedUnsupportedTools,
        enableInlineAnnotations: orgSettings.enableInlineAnnotations,
        enablePrComments: orgSettings.enablePrComments,
      }
    );

    // Release lock after successful processing (allows future re-runs to acquire)
    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    const failedRunCount = runsToProcess.filter(
      (r) => r.conclusion === "failure"
    ).length;

    return c.json({
      message: "workflow_run processed",
      repository: repository.full_name,
      prNumber,
      runsProcessed: runsToProcess.length,
      failedRuns: failedRunCount,
      totalErrors,
      checkRunId: finalCheckRunId,
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error processing [delivery: ${deliveryId}]:`,
      error
    );

    // Error recovery: Clean up check run if we have one
    // Use storedCheckRunIdForRecovery as fallback if checkRunId wasn't set yet
    const checkRunToCleanup = checkRunId ?? storedCheckRunIdForRecovery;
    if (checkRunToCleanup) {
      await attemptCheckRunCleanup(
        github,
        token,
        installation.id,
        owner,
        repo,
        checkRunToCleanup,
        deliveryId,
        error
      );
    }

    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    const classified = classifyError(error);
    captureWebhookError(
      error,
      classified.code,
      {
        eventType: "workflow_run",
        deliveryId,
        repository: repository.full_name,
        installationId: installation.id,
        workflowName: workflow_run.name,
        runId: workflow_run.id,
      },
      parserContext
    );
    return c.json(
      {
        message: "workflow_run error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};

// Auto-link installer to organization if they have an existing Detent account
// For organizations: verifies installer is still a GitHub admin before granting owner
// For personal accounts: installer is owner by definition (no verification needed)
const autoLinkInstaller = async (
  db: DbClient,
  organizationId: string,
  installerGithubId: string,
  installerUsername: string,
  orgLogin: string,
  installationId: string,
  accountType: "organization" | "user",
  env: Env
): Promise<boolean> => {
  // Check if installer already has a Detent account (via any org membership with matching GitHub ID)
  const existingMember = await db
    .select({
      userId: organizationMembers.userId,
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.providerUserId, installerGithubId))
    .limit(1);

  if (!existingMember[0]) {
    // User doesn't exist in Detent system yet - will be linked via sync-identity endpoint later
    return false;
  }

  // Check if they already have membership to this specific org
  const existingMembership = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, existingMember[0].userId),
        eq(organizationMembers.organizationId, organizationId)
      )
    )
    .limit(1);

  if (existingMembership[0]) {
    // Already a member of this org
    console.log(
      `[webhook] Installer ${installerGithubId} already has membership to org ${organizationId}`
    );
    return false;
  }

  // For organizations: verify installer is currently a GitHub admin
  // Security: Only GitHub admins should auto-claim as Detent owner
  // This mirrors the check in sync-identity endpoint for consistency
  if (accountType === "organization") {
    const membership = await verifyGitHubMembership(
      installerUsername,
      orgLogin,
      installationId,
      env
    );

    if (!(membership.isMember && membership.role === "admin")) {
      console.log(
        `[webhook] Installer ${installerUsername} is not a GitHub admin of ${orgLogin}, skipping owner auto-link`
      );
      return false;
    }
  }
  // For personal accounts: installer is the account owner by definition, no verification needed

  // Create owner membership for the installer
  await db.insert(organizationMembers).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: existingMember[0].userId,
    role: "owner",
    providerUserId: installerGithubId,
    providerUsername: installerUsername,
    providerLinkedAt: new Date(),
  });

  console.log(
    `[webhook] Auto-linked installer ${installerGithubId} (${installerUsername}) as owner to org ${organizationId}`
  );
  return true;
};

const generateUniqueSlug = async (
  db: DbClient,
  baseSlug: string
): Promise<string> => {
  const maxSlugAttempts = 10;

  // Generate all potential slugs upfront: baseSlug, baseSlug-1, baseSlug-2, ...
  const potentialSlugs = [
    baseSlug,
    ...Array.from(
      { length: maxSlugAttempts },
      (_, i) => `${baseSlug}-${i + 1}`
    ),
  ];

  // Single query to find all existing slugs that match our potential slugs
  const existingSlugs = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(inArray(organizations.slug, potentialSlugs));

  const existingSlugSet = new Set(existingSlugs.map((r) => r.slug));

  // Return the first available slug
  for (const slug of potentialSlugs) {
    if (!existingSlugSet.has(slug)) {
      return slug;
    }
  }

  // Fallback: append random suffix (all 11 potential slugs are taken)
  return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
};

// Handle installation.created event - create organization and projects
const handleInstallationCreated = async (
  db: DbClient,
  installation: InstallationPayload["installation"],
  repositories: InstallationPayload["repositories"],
  sender: InstallationPayload["sender"],
  env: Env
): Promise<
  | { organizationId: string; slug: string }
  | { existing: true; id: string; slug: string; reactivated?: boolean }
> => {
  const { account } = installation;

  // Check by providerAccountId first (survives reinstalls - GitHub org/user ID is immutable)
  const existingByAccount = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, "github"),
        eq(organizations.providerAccountId, String(account.id))
      )
    )
    .limit(1);

  if (existingByAccount[0]) {
    const existing = existingByAccount[0];

    if (existing.deletedAt) {
      // Reactivate soft-deleted org with new installation
      await db
        .update(organizations)
        .set({
          deletedAt: null,
          providerInstallationId: String(installation.id),
          installerGithubId: String(sender.id),
          providerAccountLogin: account.login, // May have changed
          providerAvatarUrl: account.avatar_url ?? null,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, existing.id));

      // Reactivate soft-deleted projects for this org
      await db
        .update(projects)
        .set({
          removedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.organizationId, existing.id),
            isNotNull(projects.removedAt)
          )
        );

      console.log(
        `[installation] Reactivated soft-deleted organization: ${existing.slug} (${existing.id})`
      );

      // Create any new projects that weren't in the previous installation
      if (repositories && repositories.length > 0) {
        const projectValues = repositories.map((repo) => ({
          id: crypto.randomUUID(),
          organizationId: existing.id,
          handle: repo.name.toLowerCase(),
          providerRepoId: String(repo.id),
          providerRepoName: repo.name,
          providerRepoFullName: repo.full_name,
          isPrivate: repo.private,
        }));

        await db.insert(projects).values(projectValues).onConflictDoNothing();
      }

      // Try to auto-link the installer if they have an existing Detent account
      await autoLinkInstaller(
        db,
        existing.id,
        String(sender.id),
        sender.login,
        account.login,
        String(installation.id),
        account.type === "Organization" ? "organization" : "user",
        env
      );

      return {
        existing: true,
        id: existing.id,
        slug: existing.slug,
        reactivated: true,
      };
    }

    // Active org exists - idempotency: update installation ID and return
    await db
      .update(organizations)
      .set({
        providerInstallationId: String(installation.id),
        providerAccountLogin: account.login, // May have changed
        providerAvatarUrl: account.avatar_url ?? null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, existing.id));

    console.log(
      `[installation] Organization already exists for account ${account.id}, updated installation: ${existing.slug}`
    );
    return { existing: true, id: existing.id, slug: existing.slug };
  }

  // Fallback: check by installation ID (handles edge case of duplicate webhooks)
  const existingByInstall = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.providerInstallationId, String(installation.id)))
    .limit(1);

  if (existingByInstall[0]) {
    console.log(
      `[installation] Organization already exists for installation ${installation.id}: ${existingByInstall[0].slug}`
    );
    return {
      existing: true,
      id: existingByInstall[0].id,
      slug: existingByInstall[0].slug,
    };
  }

  // Create organization when app is installed
  const organizationId = crypto.randomUUID();
  // Use provider-prefixed slug format: gh/login or gl/login
  const baseSlug = createProviderSlug("github", account.login);
  const slug = await generateUniqueSlug(db, baseSlug);

  await db.insert(organizations).values({
    id: organizationId,
    name: account.login,
    slug,
    provider: "github",
    providerAccountId: String(account.id),
    providerAccountLogin: account.login,
    providerAccountType:
      account.type === "Organization" ? "organization" : "user",
    providerInstallationId: String(installation.id),
    providerAvatarUrl: account.avatar_url ?? null,
    // Track installer's GitHub ID (immutable) for owner role assignment
    installerGithubId: String(sender.id),
  });

  console.log(
    `[installation] Created organization: ${slug} (${organizationId})`
  );

  // Create projects for initial repositories
  if (repositories && repositories.length > 0) {
    const projectValues = repositories.map((repo) => ({
      id: crypto.randomUUID(),
      organizationId,
      handle: repo.name.toLowerCase(), // URL-friendly handle defaults to repo name
      providerRepoId: String(repo.id),
      providerRepoName: repo.name,
      providerRepoFullName: repo.full_name,
      isPrivate: repo.private,
    }));

    await db.insert(projects).values(projectValues).onConflictDoNothing();

    console.log(
      `[installation] Created ${repositories.length} projects for organization ${slug}`
    );
  }

  // Try to auto-link the installer if they have an existing Detent account
  await autoLinkInstaller(
    db,
    organizationId,
    String(sender.id),
    sender.login,
    account.login,
    String(installation.id),
    account.type === "Organization" ? "organization" : "user",
    env
  );

  return { organizationId, slug };
};

// Handle installation events (GitHub App installed/uninstalled)
const handleInstallationEvent = async (
  c: WebhookContext,
  payload: InstallationPayload
) => {
  const { action, installation, repositories } = payload;
  const { account } = installation;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[installation] ${action}: ${account.login} (${account.type}, installation ${installation.id}) [delivery: ${deliveryId}]`
  );

  const { db, client } = await createDb(c.env);

  try {
    switch (action) {
      case "created": {
        const result = await handleInstallationCreated(
          db,
          installation,
          repositories,
          payload.sender,
          c.env
        );

        if ("existing" in result) {
          return c.json({
            message: result.reactivated
              ? "installation reactivated"
              : "installation already exists",
            organization_id: result.id,
            organization_slug: result.slug,
            account: account.login,
            reactivated: result.reactivated ?? false,
          });
        }

        return c.json({
          message: "installation created",
          organization_id: result.organizationId,
          organization_slug: result.slug,
          account: account.login,
          projects_created: repositories?.length ?? 0,
        });
      }

      case "deleted": {
        await db
          .update(organizations)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        console.log(
          `[installation] Soft-deleted organization for installation ${installation.id}`
        );

        return c.json({
          message: "installation deleted",
          account: account.login,
        });
      }

      case "suspend": {
        await db
          .update(organizations)
          .set({ suspendedAt: new Date(), updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        return c.json({
          message: "installation suspended",
          account: account.login,
        });
      }

      case "unsuspend": {
        await db
          .update(organizations)
          .set({ suspendedAt: null, updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        return c.json({
          message: "installation unsuspended",
          account: account.login,
        });
      }

      case "new_permissions_accepted": {
        // User accepted new permissions requested by the app
        // Update the organization's updatedAt to track this event
        await db
          .update(organizations)
          .set({ updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        console.log(
          `[installation] New permissions accepted for installation ${installation.id}`
        );

        return c.json({
          message: "permissions updated",
          account: account.login,
        });
      }

      default:
        return c.json({ message: "ignored", action });
    }
  } catch (error) {
    console.error(
      `[installation] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "installation",
      deliveryId,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "installation error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        account: account.login,
      },
      500
    );
  } finally {
    await client.end();
  }
};

// Handle installation_repositories events (repos added/removed from installation)
const handleInstallationRepositoriesEvent = async (
  c: WebhookContext,
  payload: InstallationRepositoriesPayload
) => {
  const { action, installation, repositories_added, repositories_removed } =
    payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[installation_repositories] ${action}: installation ${installation.id}, added=${repositories_added.length}, removed=${repositories_removed.length} [delivery: ${deliveryId}]`
  );

  const { db, client } = await createDb(c.env);

  try {
    // Find organization by installation ID
    const orgResult = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.providerInstallationId, String(installation.id)))
      .limit(1);

    const org = orgResult[0];
    if (!org) {
      console.log(
        `[installation_repositories] Organization not found for installation ${installation.id}`
      );
      return c.json({
        message: "organization not found",
        installation_id: installation.id,
      });
    }

    // Handle added repositories
    if (repositories_added.length > 0) {
      const projectValues = repositories_added.map((repo) => ({
        id: crypto.randomUUID(),
        organizationId: org.id,
        handle: repo.name.toLowerCase(), // URL-friendly handle defaults to repo name
        providerRepoId: String(repo.id),
        providerRepoName: repo.name,
        providerRepoFullName: repo.full_name,
        isPrivate: repo.private,
      }));

      await db.insert(projects).values(projectValues).onConflictDoNothing();

      console.log(
        `[installation_repositories] Created ${repositories_added.length} projects for organization ${org.slug}`
      );
    }

    // Handle removed repositories (soft-delete) - batch update for performance
    if (repositories_removed.length > 0) {
      const repoIds = repositories_removed.map((repo) => String(repo.id));
      await db
        .update(projects)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(inArray(projects.providerRepoId, repoIds));

      console.log(
        `[installation_repositories] Soft-deleted ${repositories_removed.length} projects for organization ${org.slug}`
      );
    }

    return c.json({
      message: "installation_repositories processed",
      organization_id: org.id,
      organization_slug: org.slug,
      projects_added: repositories_added.length,
      projects_removed: repositories_removed.length,
    });
  } catch (error) {
    console.error(
      `[installation_repositories] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "installation_repositories",
      deliveryId,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "installation_repositories error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        installationId: installation.id,
      },
      500
    );
  } finally {
    await client.end();
  }
};

// Handle repository events (renamed, transferred, visibility changed)
const handleRepositoryEvent = async (
  c: WebhookContext,
  payload: RepositoryPayload
) => {
  const { action, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[repository] ${action}: ${repository.full_name} (repo ID: ${repository.id}) [delivery: ${deliveryId}]`
  );

  const { db, client } = await createDb(c.env);

  try {
    // Find the project by provider repo ID
    const existingProject = await db
      .select({
        id: projects.id,
        handle: projects.handle,
        providerRepoName: projects.providerRepoName,
        providerRepoFullName: projects.providerRepoFullName,
        isPrivate: projects.isPrivate,
      })
      .from(projects)
      .where(eq(projects.providerRepoId, String(repository.id)))
      .limit(1);

    const project = existingProject[0];
    if (!project) {
      console.log(
        `[repository] Project not found for repo ID ${repository.id}, skipping`
      );
      return c.json({
        message: "project not found",
        repo_id: repository.id,
      });
    }

    switch (action) {
      case "renamed": {
        // Update repo name and full_name, but preserve custom handle
        await db
          .update(projects)
          .set({
            providerRepoName: repository.name,
            providerRepoFullName: repository.full_name,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Updated project ${project.id}: ${project.providerRepoFullName} -> ${repository.full_name}`
        );

        return c.json({
          message: "repository renamed",
          project_id: project.id,
          old_name: project.providerRepoFullName,
          new_name: repository.full_name,
        });
      }

      case "privatized":
      case "publicized": {
        const isPrivate = action === "privatized";
        await db
          .update(projects)
          .set({
            isPrivate,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Updated project ${project.id} visibility: private=${isPrivate}`
        );

        return c.json({
          message: `repository ${action}`,
          project_id: project.id,
          is_private: isPrivate,
        });
      }

      case "transferred": {
        // Repository was transferred to another owner
        // The project stays with the original org, but we update the full_name
        await db
          .update(projects)
          .set({
            providerRepoFullName: repository.full_name,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Repository transferred, updated full_name to ${repository.full_name}`
        );

        return c.json({
          message: "repository transferred",
          project_id: project.id,
          new_full_name: repository.full_name,
        });
      }

      default:
        return c.json({ message: "ignored", action });
    }
  } catch (error) {
    console.error(
      `[repository] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "repository",
      deliveryId,
      repository: repository.full_name,
      installationId: installation?.id,
    });
    return c.json(
      {
        message: "repository error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  } finally {
    await client.end();
  }
};

// Handle organization events (GitHub org renamed, etc.)
const handleOrganizationEvent = async (
  c: WebhookContext,
  payload: OrganizationPayload
) => {
  const { action, organization, changes, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[organization] ${action}: ${organization.login} (org ID: ${organization.id}) [delivery: ${deliveryId}]`
  );

  // Only handle renamed action for now
  if (action !== "renamed") {
    return c.json({ message: "ignored", action });
  }

  const oldLogin = changes?.login?.from;
  if (!oldLogin) {
    console.log("[organization] No login change found in payload, skipping");
    return c.json({ message: "ignored", reason: "no login change" });
  }

  const { db, client } = await createDb(c.env);

  try {
    // Find the organization by provider account ID (immutable)
    const existingOrg = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        providerAccountLogin: organizations.providerAccountLogin,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.provider, "github"),
          eq(organizations.providerAccountId, String(organization.id))
        )
      )
      .limit(1);

    const org = existingOrg[0];
    if (!org) {
      console.log(
        `[organization] Organization not found for GitHub org ID ${organization.id}, skipping`
      );
      return c.json({
        message: "organization not found",
        github_org_id: organization.id,
      });
    }

    // Update providerAccountLogin
    const updates: {
      providerAccountLogin: string;
      providerAvatarUrl: string | null;
      updatedAt: Date;
      slug?: string;
      name?: string;
    } = {
      providerAccountLogin: organization.login,
      providerAvatarUrl: organization.avatar_url ?? null,
      updatedAt: new Date(),
    };

    // Check if slug matches the provider pattern (gh/old-login)
    const oldProviderSlug = createProviderSlug("github", oldLogin);
    if (org.slug === oldProviderSlug) {
      // Update slug to match new login
      const newProviderSlug = createProviderSlug("github", organization.login);
      updates.slug = newProviderSlug;
      updates.name = organization.login;
    }

    await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, org.id));

    console.log(
      `[organization] Updated organization ${org.id}: login ${oldLogin} -> ${organization.login}${
        updates.slug ? `, slug ${org.slug} -> ${updates.slug}` : ""
      }`
    );

    return c.json({
      message: "organization renamed",
      organization_id: org.id,
      old_login: oldLogin,
      new_login: organization.login,
      old_slug: org.slug,
      new_slug: updates.slug ?? org.slug,
    });
  } catch (error) {
    console.error(
      `[organization] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "organization",
      deliveryId,
      installationId: installation?.id,
    });
    return c.json(
      {
        message: "organization error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        organization: organization.login,
      },
      500
    );
  } finally {
    await client.end();
  }
};

// ============================================================================
// Helper: Post "waiting" comment immediately when PR is created
// ============================================================================
// Posts a waiting comment to explain that Detent is monitoring CI.
// This comment will be updated with actual results when CI completes.

interface PostWaitingCommentContext {
  env: Env;
  token: string;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  headSha: string;
  /** First line of the commit message from check_suite.head_commit.message */
  headCommitMessage?: string;
}

const postWaitingComment = async (
  ctx: PostWaitingCommentContext
): Promise<void> => {
  const {
    env,
    token,
    owner,
    repo,
    repository,
    prNumber,
    headSha,
    headCommitMessage,
  } = ctx;
  const kv = env["detent-idempotency"];

  // Acquire lock to prevent race conditions when multiple workflows trigger simultaneously
  const lock = await acquirePrCommentLock(kv, repository, prNumber);
  if (!lock.acquired) {
    console.log(
      `[webhook] PR comment lock not acquired for ${repository}#${prNumber}, skipping waiting comment`
    );
    return;
  }

  try {
    const waitingBody = formatWaitingComment({ headSha, headCommitMessage });
    const github = createGitHubService(env);
    const shortSha = headSha.slice(0, 7);

    // Check if comment exists after acquiring lock (handles race condition)
    const existingCommentId = await getStoredCommentId(
      kv,
      repository,
      prNumber
    );
    if (existingCommentId) {
      // Update existing comment to show "waiting" for the new commit
      // This handles the case where a previous commit had results (pass/fail)
      // and a new commit is pushed - we want to show we're waiting on the new commit
      await github.updateComment(
        token,
        owner,
        repo,
        existingCommentId,
        waitingBody
      );
      console.log(
        `[webhook] Updated comment ${existingCommentId} to waiting state for ${shortSha} on ${repository}#${prNumber}`
      );
      return;
    }

    // Post new waiting comment if none exists

    const { id: commentId } = await github.postCommentWithId(
      token,
      owner,
      repo,
      prNumber,
      waitingBody
    );

    // Store comment ID in KV for later updates
    await storeCommentId(kv, repository, prNumber, commentId);

    // Store in DB for persistence
    const { db, client } = await createDb(env);
    try {
      await upsertCommentIdInDb(db, repository, prNumber, String(commentId));
    } finally {
      await client.end();
    }

    console.log(
      `[webhook] Posted waiting comment ${commentId} on ${repository}#${prNumber}`
    );
  } catch (error) {
    // Non-fatal - the comment will be created when workflow completes if this fails
    console.error("[webhook] Error posting waiting comment:", error);
  } finally {
    await releasePrCommentLock(kv, repository, prNumber);
  }
};

// Handle check_suite.requested - create a "queued" check run immediately
const handleCheckSuiteRequested = async (
  c: WebhookContext,
  payload: CheckSuitePayload
) => {
  const { action, check_suite, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only handle "requested" action
  if (action !== "requested") {
    return c.json({ message: "ignored", action });
  }

  // Skip if no PR associated (e.g., push to main branch)
  if (check_suite.pull_requests.length === 0) {
    console.log(
      `[check_suite] No PR associated with ${check_suite.head_sha.slice(0, 7)}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: "skipped",
      reason: "no_pr",
      branch: check_suite.head_branch,
    });
  }

  const headSha = check_suite.head_sha;
  const firstPr = check_suite.pull_requests[0];
  if (!firstPr) {
    // Should never happen after length check, but satisfy TypeScript
    return c.json({ message: "skipped", reason: "no_pr" });
  }
  const prNumber = firstPr.number;
  const kv = c.env["detent-idempotency"];

  console.log(
    `[check_suite] Requested: ${repository.full_name} @ ${headSha.slice(0, 7)} (PR #${prNumber}) [delivery: ${deliveryId}]`
  );

  // Check if check run already exists (idempotency)
  const existingCheckRunId = await getStoredCheckRunId(
    kv,
    repository.full_name,
    headSha
  );

  if (existingCheckRunId) {
    console.log(
      `[check_suite] Check run ${existingCheckRunId} already exists for ${headSha.slice(0, 7)}`
    );
    return c.json({
      message: "check run already exists",
      checkRunId: existingCheckRunId,
    });
  }

  const github = createGitHubService(c.env);

  try {
    const token = await github.getInstallationToken(installation.id);

    // Create a "queued" check run so users know we're watching
    const checkRun = await github.createCheckRun(token, {
      owner: repository.owner.login,
      repo: repository.name,
      headSha,
      name: "Detent Parser",
      status: "queued",
      output: {
        title: "Waiting for CI to complete...",
        summary: "Detent will analyze CI results once all workflows finish.",
      },
    });

    console.log(
      `[check_suite] Created queued check run ${checkRun.id} for ${headSha.slice(0, 7)}`
    );

    // Fire-and-forget background tasks (non-blocking for faster response)
    c.executionCtx.waitUntil(
      Promise.all([
        // Store check run ID for later retrieval
        storeCheckRunId(kv, repository.full_name, headSha, checkRun.id),
        // Post waiting comment immediately so users know we're watching
        postWaitingComment({
          env: c.env,
          token,
          owner: repository.owner.login,
          repo: repository.name,
          repository: repository.full_name,
          prNumber,
          headSha,
          headCommitMessage: check_suite.head_commit?.message,
        }),
      ])
    );

    return c.json({
      message: "check run created",
      checkRunId: checkRun.id,
      status: "queued",
    });
  } catch (error) {
    console.error(
      `[check_suite] Error creating queued check run [delivery: ${deliveryId}]:`,
      error
    );

    // Return 500 to be consistent with other error handlers in this file
    // The check run will be created when workflow_run.in_progress fires as fallback
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "check_suite",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "failed to create check run",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};

// Handle issue_comment events (@detent mentions)
const handleIssueCommentEvent = async (
  c: WebhookContext,
  payload: IssueCommentPayload
) => {
  const { action, comment, issue, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only process new comments
  if (action !== "created") {
    return c.json({ message: "ignored", reason: "not created" });
  }

  // Only process PR comments (not issues)
  if (!issue.pull_request) {
    return c.json({ message: "ignored", reason: "not a pull request" });
  }

  // Ignore comments from bots (e.g., changeset-bot mentions @detent/cli package names)
  if (comment.user.type === "Bot") {
    return c.json({ message: "ignored", reason: "bot comment" });
  }

  // Check for @detent mention
  const body = comment.body.toLowerCase();
  if (!body.includes("@detent")) {
    return c.json({ message: "ignored", reason: "no @detent mention" });
  }

  console.log(
    `[issue_comment] @detent mentioned in ${repository.full_name}#${issue.number} by ${comment.user.login}`
  );

  // Parse command
  const command = parseDetentCommand(comment.body);

  // Get GitHub service
  const github = createGitHubService(c.env);

  try {
    // Get installation token
    const token = await github.getInstallationToken(installation.id);

    switch (command.type) {
      case "status": {
        // Future: Report current error status from stored analysis
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          "📊 **Detent** status check is not yet implemented."
        );
        return c.json({
          message: "status command received",
          status: "not_implemented",
        });
      }

      case "help": {
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          formatHelpMessage()
        );
        return c.json({ message: "help command received", status: "posted" });
      }

      default: {
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          `🤔 Unknown command. ${formatHelpMessage()}`
        );
        return c.json({ message: "unknown command", status: "posted" });
      }
    }
  } catch (error) {
    console.error(
      `[issue_comment] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "issue_comment",
      deliveryId,
      repository: repository.full_name,
      installationId: installation.id,
      prNumber: issue.number,
    });
    return c.json(
      {
        message: "issue_comment error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};

// Parse @detent commands from comment body
const parseDetentCommand = (body: string): DetentCommand => {
  const lower = body.toLowerCase();

  if (lower.includes("@detent status")) {
    return { type: "status" };
  }

  if (lower.includes("@detent help")) {
    return { type: "help" };
  }

  return { type: "unknown" };
};

// Format help message
const formatHelpMessage = (): string => {
  return `**Available commands:**
- \`@detent status\` - Show current error status
- \`@detent help\` - Show this message`;
};

export default app;
