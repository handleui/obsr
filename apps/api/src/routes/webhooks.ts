import type { KVNamespace } from "@cloudflare/workers-types";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  createProviderSlug,
  organizationMembers,
  organizations,
  prComments,
  projects,
  runErrors,
  runs,
} from "../db/schema";
import { webhookSignatureMiddleware } from "../middleware/webhook-signature";
import {
  formatCheckSummary,
  formatResultsComment,
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
  markCommitProcessed,
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
    user: { login: string };
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

interface DetentCommand {
  type: "heal" | "status" | "help" | "unknown";
  dryRun?: boolean;
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
    | OrganizationPayload;
}

type WebhookContext = Context<{ Bindings: Env; Variables: WebhookVariables }>;

const app = new Hono<{ Bindings: Env; Variables: WebhookVariables }>();

// GitHub webhook endpoint
// Receives: workflow_run, issue_comment events
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

    default:
      console.log(`[webhook] Ignoring unhandled event: ${event}`);
      return c.json({ message: "ignored", event });
  }
});

// ParsedError is imported from ../services/error-parser

// Store run and errors in the database
const storeRunAndErrors = async (
  env: Env,
  data: {
    runId: number;
    runName: string;
    prNumber: number;
    headSha: string;
    errors: ParsedError[];
    repository: string;
    checkRunId?: number;
  }
): Promise<string> => {
  const { db, client } = await createDb(env);

  try {
    const runRecordId = crypto.randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(runs).values({
        id: runRecordId,
        provider: "github",
        source: "github",
        format: "github-actions",
        runId: String(data.runId),
        repository: data.repository,
        commitSha: data.headSha,
        prNumber: data.prNumber,
        checkRunId: data.checkRunId ? String(data.checkRunId) : null,
        errorCount: data.errors.length,
      });

      if (data.errors.length > 0) {
        const errorRows = data.errors.map((error) => ({
          id: crypto.randomUUID(),
          runId: runRecordId,
          filePath: error.filePath ?? null,
          line: error.line ?? null,
          column: error.column ?? null,
          message: error.message,
          category: error.category ?? null,
          severity: error.severity ?? null,
          ruleId: error.ruleId ?? null,
          source: error.source ?? null,
          stackTrace: error.stackTrace ?? null,
          hint: error.hint ?? null,
          workflowJob: error.workflowJob ?? data.runName,
          workflowStep: error.workflowStep ?? null,
          workflowAction: error.workflowAction ?? null,
        }));
        await tx.insert(runErrors).values(errorRows);
      }
    });

    console.log(
      `[workflow_run] Stored run ${data.runId} with ${data.errors.length} errors`
    );
    return runRecordId;
  } finally {
    await client.end();
  }
};

// ============================================================================
// Helper: Check if commit already has stored runs in database
// ============================================================================
const checkExistingRunsInDb = async (
  env: Env,
  repository: string,
  headSha: string
): Promise<boolean> => {
  const { db, client } = await createDb(env);
  try {
    const existingRuns = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.repository, repository), eq(runs.commitSha, headSha)))
      .limit(1);
    return existingRuns.length > 0;
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
 */
const upsertCommentIdInDb = async (
  db: DbClient,
  repository: string,
  prNumber: number,
  commentId: string
): Promise<void> => {
  const normalizedRepo = repository.toLowerCase();

  try {
    // Check if record exists
    const existing = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.repository, normalizedRepo),
          eq(prComments.prNumber, prNumber)
        )
      )
      .limit(1);

    if (existing[0]) {
      // Update existing record
      await db
        .update(prComments)
        .set({
          commentId,
          updatedAt: new Date(),
        })
        .where(eq(prComments.id, existing[0].id));
      console.log(
        `[pr-comments] Updated comment ID in DB for ${repository}#${prNumber}: ${commentId}`
      );
    } else {
      // Insert new record
      await db.insert(prComments).values({
        id: crypto.randomUUID(),
        repository: normalizedRepo,
        prNumber,
        commentId,
      });
      console.log(
        `[pr-comments] Stored new comment ID in DB for ${repository}#${prNumber}: ${commentId}`
      );
    }
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
// Helper: Process and store failed runs with batched parallel execution
// ============================================================================
//
// Performance notes (Cloudflare Workers - 128MB limit):
// - Fetches logs in parallel batches (MAX_CONCURRENT_FETCHES) to reduce latency
// - Parses logs immediately after fetch to free memory before next batch
// - Stores runs in parallel batches to reduce database round-trips
// - Each batch completes before next starts to bound memory usage
const processFailedRuns = async (
  env: Env,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  failedRuns: Array<{ id: number; name: string }>,
  context: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    repository: string;
    checkRunId: number;
  }
): Promise<ParsedError[]> => {
  // Limit concurrent fetches to avoid memory pressure from multiple ZIP files
  // Each workflow log can be up to 30MB compressed, so we keep this conservative
  const MAX_CONCURRENT_FETCHES = 3;
  const MAX_CONCURRENT_STORES = 5;

  const allErrors: ParsedError[] = [];
  const runDataList: Array<{
    runId: number;
    runName: string;
    errors: ParsedError[];
  }> = [];

  // Process a single run: fetch logs, parse, and return result
  const processRun = async (run: {
    id: number;
    name: string;
  }): Promise<{
    runId: number;
    runName: string;
    errors: ParsedError[];
  }> => {
    try {
      // Fetch logs from GitHub API
      const logsResult = await github.fetchWorkflowLogs(
        token,
        context.owner,
        context.repo,
        run.id
      );

      // DEBUG: Log first 2000 chars of raw log content
      console.log(
        `[DEBUG] Run ${run.id} raw logs (first 2000 chars):\n`,
        logsResult.logs.slice(0, 2000)
      );
      console.log(
        `[DEBUG] Run ${run.id} log stats: ${logsResult.totalBytes} bytes, ${logsResult.jobCount} jobs`
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

      // DEBUG: Log parsed errors
      console.log(
        `[DEBUG] Run ${run.id} parsed ${parseResult.errors.length} errors:`,
        JSON.stringify(parseResult.errors.slice(0, 5), null, 2)
      );

      // Attach workflow context to each error
      const errorsWithContext = parseResult.errors.map((e) => ({
        ...e,
        workflowJob: e.workflowJob ?? run.name,
      }));

      console.log(
        `[workflow_run] Parsed ${errorsWithContext.length} errors from run ${run.id} (${run.name})`
      );

      return {
        runId: run.id,
        runName: run.name,
        errors: errorsWithContext,
      };
    } catch (error) {
      // If log fetching/parsing fails, use a fallback error
      // Log full error internally for debugging
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

      return {
        runId: run.id,
        runName: run.name,
        errors: [fallbackError],
      };
    }
  };

  // Fetch and parse logs in parallel batches
  // This reduces total latency while bounding memory usage
  for (let i = 0; i < failedRuns.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = failedRuns.slice(i, i + MAX_CONCURRENT_FETCHES);
    const results = await Promise.all(batch.map(processRun));

    // Collect results from this batch
    for (const result of results) {
      allErrors.push(...result.errors);
      runDataList.push(result);
    }
  }

  // Store runs in batches to avoid memory pressure (Workers: 128MB limit)
  for (let i = 0; i < runDataList.length; i += MAX_CONCURRENT_STORES) {
    const batch = runDataList.slice(i, i + MAX_CONCURRENT_STORES);
    await Promise.all(
      batch.map((runData) =>
        storeRunAndErrors(env, {
          runId: runData.runId,
          runName: runData.runName,
          prNumber: context.prNumber,
          headSha: context.headSha,
          errors: runData.errors,
          repository: context.repository,
          checkRunId: context.checkRunId,
        })
      )
    );
  }

  return allErrors;
};

// ============================================================================
// Helper: Clean up check run on error (prevents stale "in progress" state)
// ============================================================================
const cleanupCheckRunOnError = async (
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  checkRunId: number
): Promise<void> => {
  try {
    await github.updateCheckRun(token, {
      owner,
      repo,
      checkRunId,
      status: "completed",
      conclusion: "cancelled",
      output: {
        title: "Analysis failed",
        summary:
          "An error occurred while analyzing CI results. This webhook may be retried.",
      },
    });
    console.log(
      `[workflow_run] Cleaned up check run ${checkRunId} after error`
    );
  } catch (cleanupError) {
    console.error(
      `[workflow_run] Failed to clean up check run ${checkRunId}:`,
      cleanupError
    );
  }
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
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  commentBody: string;
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
    owner,
    repo,
    repository,
    prNumber,
    commentBody,
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
    headSha: string;
    prNumber: number;
    checkRunId: number;
    workflowRuns: WorkflowRun[];
    allErrors: ParsedError[];
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
    headSha,
    prNumber,
    checkRunId,
    workflowRuns,
    allErrors,
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

  // Update check run to completed
  await github.updateCheckRun(token, {
    owner,
    repo,
    checkRunId,
    status: "completed",
    conclusion: hasFailed ? "failure" : "success",
    output: {
      title: hasFailed
        ? `${totalErrors} error${totalErrors !== 1 ? "s" : ""} found`
        : "All checks passed",
      summary: formatCheckSummary(runResults, totalErrors),
    },
  });

  // Only post/update comment if there are failures
  if (!hasFailed) {
    console.log(
      `[workflow_run] All checks passed - no comment posted on PR #${prNumber}`
    );
    return { runResults, totalErrors };
  }

  // Acquire PR comment lock to prevent race conditions
  const prLock = await acquirePrCommentLock(kv, repository, prNumber);
  if (!prLock.acquired) {
    console.log(
      `[workflow_run] PR comment lock not acquired for ${repository}#${prNumber}, skipping comment`
    );
    return { runResults, totalErrors };
  }

  const { db, client } = await createDb(env);

  try {
    const commentBody = formatResultsComment({
      owner,
      repo,
      headSha,
      runs: runResults,
      errors: allErrors,
      totalErrors,
    });

    await postOrUpdateComment({
      github,
      token,
      kv,
      db,
      owner,
      repo,
      repository,
      prNumber,
      commentBody,
    });
  } finally {
    await client.end();
    await releasePrCommentLock(kv, repository, prNumber);
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

  // Skip if no PR associated (e.g., push to main branch)
  if (workflow_run.pull_requests.length === 0) {
    console.log(
      `[workflow_run] No PR associated with ${workflow_run.name}, skipping [delivery: ${deliveryId}]`
    );
    return c.json({
      message: "skipped",
      reason: "no_pr",
      branch: workflow_run.head_branch,
    });
  }

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
    return c.json({
      message: "failed to create check run",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Handle workflow_run events (CI completed)
// Waits for ALL workflow runs for a commit to complete before posting comment
//
// Robustness features:
// - Idempotency: Uses KV-backed lock to prevent duplicate processing (survives Worker restarts)
// - Race condition handling: Returns early if another webhook is processing
// - Error recovery: Cleans up check run on failure
// - Database-backed deduplication: Unique constraint on (repository, commitSha, runId)
const handleWorkflowRunCompleted = async (
  c: WebhookContext,
  payload: WorkflowRunPayload
) => {
  const { workflow_run, repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const headSha = workflow_run.head_sha;
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

  try {
    token = await github.getInstallationToken(installation.id);

    // Get PR number (skip if no PR associated)
    const prFromPayload = workflow_run.pull_requests[0]?.number;
    const prNumber =
      prFromPayload ??
      (await github.getPullRequestForRun(token, owner, repo, workflow_run.id));

    if (!prNumber) {
      console.log("[workflow_run] No associated PR found, skipping");
      await markCommitProcessed(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      return c.json({
        message: "workflow_run processed",
        repository: repository.full_name,
        runId: workflow_run.id,
        status: "no_pr",
      });
    }

    // Check if ALL workflow runs for this commit are done BEFORE creating check run
    const { allCompleted, runs: workflowRuns } =
      await github.listWorkflowRunsForCommit(token, owner, repo, headSha);

    if (!allCompleted) {
      await releaseCommitLock(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      const pendingCount = workflowRuns.filter(
        (r) => r.status !== "completed"
      ).length;
      console.log(
        `[workflow_run] Waiting for ${pendingCount} more runs to complete`
      );
      return c.json({
        message: "waiting for other runs",
        repository: repository.full_name,
        completed: workflowRuns.filter((r) => r.status === "completed").length,
        pending: pendingCount,
      });
    }

    // Database-backed idempotency: verify we haven't already stored runs
    const hasExistingRuns = await checkExistingRunsInDb(
      c.env,
      repository.full_name,
      headSha
    );
    if (hasExistingRuns) {
      console.log(
        `[workflow_run] Commit ${headSha.slice(0, 7)} already has stored runs, skipping [delivery: ${deliveryId}]`
      );
      await markCommitProcessed(
        c.env["detent-idempotency"],
        repository.full_name,
        headSha
      );
      return c.json({
        message: "already processed (db check)",
        repository: repository.full_name,
        headSha,
        status: "duplicate_db",
      });
    }

    // All runs completed! Get or create check run
    // First, try to retrieve the check run we created on in_progress
    const storedCheckRunId = await getStoredCheckRunId(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    if (storedCheckRunId) {
      // Update existing check run to in_progress
      checkRunId = storedCheckRunId;
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

    // Process failed runs
    const failedRuns = workflowRuns.filter((r) => r.conclusion === "failure");
    const allErrors = await processFailedRuns(
      c.env,
      github,
      token,
      failedRuns,
      {
        owner,
        repo,
        prNumber,
        headSha,
        repository: repository.full_name,
        checkRunId: finalCheckRunId,
      }
    );

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
        headSha,
        prNumber,
        checkRunId: finalCheckRunId,
        workflowRuns,
        allErrors,
      }
    );

    await markCommitProcessed(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha,
      finalCheckRunId
    );

    return c.json({
      message: "workflow_run processed",
      repository: repository.full_name,
      prNumber,
      runsProcessed: workflowRuns.length,
      failedRuns: failedRuns.length,
      totalErrors,
      checkRunId: finalCheckRunId,
    });
  } catch (error) {
    console.error(
      `[workflow_run] Error processing [delivery: ${deliveryId}]:`,
      error
    );

    // Error recovery: Clean up check run if we created one
    if (checkRunId && token) {
      await cleanupCheckRunOnError(github, token, owner, repo, checkRunId);
    }

    await releaseCommitLock(
      c.env["detent-idempotency"],
      repository.full_name,
      headSha
    );

    return c.json(
      {
        message: "workflow_run error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
};

// Auto-link installer to organization if they have an existing Detent account
const autoLinkInstaller = async (
  db: DbClient,
  organizationId: string,
  installerGithubId: string,
  installerUsername: string
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
  sender: InstallationPayload["sender"]
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
      await autoLinkInstaller(db, existing.id, String(sender.id), sender.login);

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
  await autoLinkInstaller(db, organizationId, String(sender.id), sender.login);

  return { organizationId, slug };
};

// Handle installation events (GitHub App installed/uninstalled)
const handleInstallationEvent = async (
  c: WebhookContext,
  payload: InstallationPayload
) => {
  const { action, installation, repositories } = payload;
  const { account } = installation;

  console.log(
    `[installation] ${action}: ${account.login} (${account.type}, installation ${installation.id})`
  );

  const { db, client } = await createDb(c.env);

  try {
    switch (action) {
      case "created": {
        const result = await handleInstallationCreated(
          db,
          installation,
          repositories,
          payload.sender
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
    console.error("[installation] Error processing:", error);
    return c.json(
      {
        message: "installation error",
        error: error instanceof Error ? error.message : "Unknown error",
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

  console.log(
    `[installation_repositories] ${action}: installation ${installation.id}, added=${repositories_added.length}, removed=${repositories_removed.length}`
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
    console.error("[installation_repositories] Error processing:", error);
    return c.json(
      {
        message: "installation_repositories error",
        error: error instanceof Error ? error.message : "Unknown error",
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

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[repository] ${action}: ${repository.full_name} (repo ID: ${repository.id})`
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
    console.error("[repository] Error processing:", error);
    return c.json(
      {
        message: "repository error",
        error: error instanceof Error ? error.message : "Unknown error",
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

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[organization] ${action}: ${organization.login} (org ID: ${organization.id})`
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
    console.error("[organization] Error processing:", error);
    return c.json(
      {
        message: "organization error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  } finally {
    await client.end();
  }
};

// Handle issue_comment events (@detent mentions)
const handleIssueCommentEvent = async (
  c: WebhookContext,
  payload: IssueCommentPayload
) => {
  const { action, comment, issue, repository, installation } = payload;

  // Only process new comments
  if (action !== "created") {
    return c.json({ message: "ignored", reason: "not created" });
  }

  // Only process PR comments (not issues)
  if (!issue.pull_request) {
    return c.json({ message: "ignored", reason: "not a pull request" });
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
      case "heal": {
        // HACK: Commenting out acknowledgment comment for now - will be used for cloud healing later
        // await github.postComment(
        //   token,
        //   repository.owner.login,
        //   repository.name,
        //   issue.number,
        //   `🔧 **Detent** is analyzing the CI failures${command.dryRun ? " (dry run)" : ""}...`
        // );

        // Healing flow will:
        // 1. Find latest failed workflow run
        // 2. Fetch and parse logs with @detent/parser
        // 3. Run healing loop with Claude via @detent/healing
        // 4. Push fix (if not dry run)
        // 5. Post results

        return c.json({
          message: "heal command received",
          repository: repository.full_name,
          issue: issue.number,
          dryRun: command.dryRun,
          status: "acknowledged",
        });
      }

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
    console.error("[issue_comment] Error processing:", error);
    return c.json(
      {
        message: "issue_comment error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
};

// Parse @detent commands from comment body
const parseDetentCommand = (body: string): DetentCommand => {
  const lower = body.toLowerCase();

  if (lower.includes("@detent heal")) {
    const dryRun = lower.includes("--dry") || lower.includes("--dry-run");
    return { type: "heal", dryRun };
  }

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
- \`@detent heal\` - Analyze errors and attempt automatic fixes
- \`@detent heal --dry-run\` - Analyze without pushing changes
- \`@detent status\` - Show current error status
- \`@detent help\` - Show this message`;
};

export default app;
