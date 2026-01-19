/**
 * Autofix Result API route
 *
 * Receives autofix results from the GitHub Action.
 * Authenticated via API key (X-Detent-Token header).
 */

import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Database } from "../db/client";
import {
  applyHeal,
  getHealByPrAndSource,
  updateHealStatus,
} from "../db/operations/heals";
import {
  getOrgSettings,
  type Heal,
  type OrganizationSettings,
  projects,
} from "../db/schema";
import { apiKeyAuthMiddleware } from "../middleware/api-key-auth";
import { apiKeyRateLimitMiddleware } from "../middleware/api-key-rate-limit";
import { generateAutofixCommitMessage } from "../services/autofix/commit-message";
import { createGitHubService, type GitHubService } from "../services/github";
import { getBranchHead, pushHealCommit } from "../services/github/commit-push";
import { validateFilePath } from "../services/github/validation";
import type { Env } from "../types/env";

// ============================================================================
// Types
// ============================================================================

interface AutofixResultItem {
  source: string;
  success: boolean;
  patch?: string;
  filesChanged?: Array<{ path: string; content: string | null }>;
  error?: string;
}

interface AutofixResultPayload {
  projectId: string;
  runId: string;
  prNumber: number;
  results: AutofixResultItem[];
}

interface ProcessedResult {
  source: string;
  healId: string | null;
  status: "completed" | "failed" | "applied" | "not_found";
  commitSha?: string;
  error?: string;
}

// ============================================================================
// Validation Constants
// ============================================================================

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 50;
const MAX_SOURCE_LENGTH = 64;
const MAX_PATCH_LENGTH = 1_000_000; // 1MB
const MAX_ERROR_LENGTH = 10_000;
const MAX_FILES_CHANGED = 500;
const MAX_FILE_PATH_LENGTH = 2048;
const MAX_FILE_CONTENT_LENGTH = 10_000_000; // 10MB per file

type ValidationResult =
  | { valid: true; payload: AutofixResultPayload }
  | { valid: false; error: string };

// ============================================================================
// Validation Helpers
// ============================================================================

const validateTopLevelFields = (
  b: Record<string, unknown>
): { valid: false; error: string } | null => {
  if (typeof b.projectId !== "string") {
    return { valid: false, error: "projectId must be a string" };
  }
  if (!UUID_PATTERN.test(b.projectId)) {
    return { valid: false, error: "projectId must be a valid UUID" };
  }
  if (typeof b.runId !== "string") {
    return { valid: false, error: "runId must be a string" };
  }
  if (!UUID_PATTERN.test(b.runId)) {
    return { valid: false, error: "runId must be a valid UUID" };
  }
  if (
    typeof b.prNumber !== "number" ||
    !Number.isInteger(b.prNumber) ||
    b.prNumber <= 0
  ) {
    return { valid: false, error: "prNumber must be a positive integer" };
  }
  return null;
};

const validateResultsArray = (
  results: unknown
): { valid: false; error: string } | null => {
  if (!Array.isArray(results)) {
    return { valid: false, error: "results must be an array" };
  }
  if (results.length === 0) {
    return { valid: false, error: "results array cannot be empty" };
  }
  if (results.length > MAX_RESULTS) {
    return {
      valid: false,
      error: `results array exceeds maximum of ${MAX_RESULTS} items`,
    };
  }
  return null;
};

const validateFileChange = (
  file: unknown,
  i: number,
  j: number
): { valid: false; error: string } | null => {
  if (!file || typeof file !== "object") {
    return {
      valid: false,
      error: `results[${i}].filesChanged[${j}] must be an object`,
    };
  }

  const f = file as Record<string, unknown>;

  if (typeof f.path !== "string" || f.path.length === 0) {
    return {
      valid: false,
      error: `results[${i}].filesChanged[${j}].path must be a non-empty string`,
    };
  }
  if (f.path.length > MAX_FILE_PATH_LENGTH) {
    return {
      valid: false,
      error: `results[${i}].filesChanged[${j}].path exceeds maximum length`,
    };
  }

  // SECURITY: Validate file path to prevent path traversal attacks
  // This rejects paths with "..", absolute paths, and control characters
  try {
    validateFilePath(f.path, `results[${i}].filesChanged[${j}].path`);
  } catch (error) {
    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : `results[${i}].filesChanged[${j}].path is invalid`,
    };
  }

  if (f.content !== null && typeof f.content !== "string") {
    return {
      valid: false,
      error: `results[${i}].filesChanged[${j}].content must be a string or null`,
    };
  }
  if (
    typeof f.content === "string" &&
    f.content.length > MAX_FILE_CONTENT_LENGTH
  ) {
    return {
      valid: false,
      error: `results[${i}].filesChanged[${j}].content exceeds maximum length`,
    };
  }
  return null;
};

const validateFilesChanged = (
  filesChanged: unknown,
  i: number
): { valid: false; error: string } | null => {
  if (filesChanged === undefined) {
    return null;
  }
  if (!Array.isArray(filesChanged)) {
    return {
      valid: false,
      error: `results[${i}].filesChanged must be an array`,
    };
  }
  if (filesChanged.length > MAX_FILES_CHANGED) {
    return {
      valid: false,
      error: `results[${i}].filesChanged exceeds maximum of ${MAX_FILES_CHANGED} files`,
    };
  }

  for (const [j, file] of filesChanged.entries()) {
    const fileError = validateFileChange(file, i, j);
    if (fileError) {
      return fileError;
    }
  }
  return null;
};

const validateSingleResult = (
  result: unknown,
  i: number
): { valid: false; error: string } | null => {
  if (!result || typeof result !== "object") {
    return { valid: false, error: `results[${i}] must be an object` };
  }

  const r = result as Record<string, unknown>;

  // source (required)
  if (typeof r.source !== "string" || r.source.length === 0) {
    return {
      valid: false,
      error: `results[${i}].source must be a non-empty string`,
    };
  }
  if (r.source.length > MAX_SOURCE_LENGTH) {
    return {
      valid: false,
      error: `results[${i}].source exceeds maximum length`,
    };
  }

  // success (required)
  if (typeof r.success !== "boolean") {
    return { valid: false, error: `results[${i}].success must be a boolean` };
  }

  // patch (optional)
  if (r.patch !== undefined && typeof r.patch !== "string") {
    return { valid: false, error: `results[${i}].patch must be a string` };
  }
  if (typeof r.patch === "string" && r.patch.length > MAX_PATCH_LENGTH) {
    return {
      valid: false,
      error: `results[${i}].patch exceeds maximum length`,
    };
  }

  // error (optional)
  if (r.error !== undefined && typeof r.error !== "string") {
    return { valid: false, error: `results[${i}].error must be a string` };
  }
  if (typeof r.error === "string" && r.error.length > MAX_ERROR_LENGTH) {
    return {
      valid: false,
      error: `results[${i}].error exceeds maximum length`,
    };
  }

  // filesChanged (optional)
  const filesError = validateFilesChanged(r.filesChanged, i);
  if (filesError) {
    return filesError;
  }

  return null;
};

const validatePayload = (body: unknown): ValidationResult => {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be an object" };
  }

  const b = body as Record<string, unknown>;

  const topLevelError = validateTopLevelFields(b);
  if (topLevelError) {
    return topLevelError;
  }

  const resultsError = validateResultsArray(b.results);
  if (resultsError) {
    return resultsError;
  }

  const results = b.results as unknown[];
  for (const [i, result] of results.entries()) {
    const resultError = validateSingleResult(result, i);
    if (resultError) {
      return resultError;
    }
  }

  return {
    valid: true,
    payload: {
      projectId: b.projectId as string,
      runId: b.runId as string,
      prNumber: b.prNumber as number,
      results: b.results as AutofixResultItem[],
    },
  };
};

// ============================================================================
// Result Processing Helpers
// ============================================================================

interface AutoCommitContext {
  github: GitHubService;
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
}

const autoCommitHeal = async (
  db: Database,
  heal: Heal,
  filesChanged: Array<{ path: string; content: string | null }>,
  ctx: AutoCommitContext
): Promise<ProcessedResult> => {
  const { github, installationId, owner, repo, prNumber } = ctx;

  const token = await github.getInstallationToken(Number(installationId));
  const prInfo = await github.getPullRequestInfo(token, owner, repo, prNumber);

  if (!prInfo) {
    console.warn(`[autofix-result] PR #${prNumber} not found for auto-commit`);
    return {
      source: heal.autofixSource ?? "unknown",
      healId: heal.id,
      status: "completed",
      error: "PR not found for auto-commit",
    };
  }

  const baseSha = await getBranchHead(token, owner, repo, prInfo.headBranch);
  const commitMessage =
    heal.commitMessage ??
    generateAutofixCommitMessage(
      heal.autofixSource,
      heal.errorIds?.length ?? 0
    );

  const commitResult = await pushHealCommit({
    token,
    owner,
    repo,
    branch: prInfo.headBranch,
    baseSha,
    filesChanged,
    commitMessage,
    verifyBaseSha: true,
  });

  await applyHeal(db, heal.id, commitResult.sha);

  console.log(
    `[autofix-result] Auto-committed heal ${heal.id} with SHA ${commitResult.sha}`
  );

  return {
    source: heal.autofixSource ?? "unknown",
    healId: heal.id,
    status: "applied",
    commitSha: commitResult.sha,
  };
};

const processSuccessResult = async (
  db: Database,
  heal: Heal,
  result: AutofixResultItem,
  orgSettings: Required<OrganizationSettings>,
  autoCommitCtx: AutoCommitContext | null
): Promise<ProcessedResult> => {
  // Update heal to completed with patch and files
  await updateHealStatus(db, heal.id, "completed", {
    patch: result.patch,
    filesChanged: result.filesChanged?.map((f) => f.path),
    filesChangedWithContent: result.filesChanged,
  });

  console.log(
    `[autofix-result] Updated heal ${heal.id} to completed (${result.filesChanged?.length ?? 0} files)`
  );

  // Check if auto-commit is enabled and possible
  if (
    orgSettings.autofixAutoCommit &&
    result.filesChanged?.length &&
    autoCommitCtx
  ) {
    try {
      return await autoCommitHeal(db, heal, result.filesChanged, autoCommitCtx);
    } catch (commitError) {
      console.error(
        `[autofix-result] Failed to auto-commit heal ${heal.id}:`,
        commitError
      );
      return {
        source: result.source,
        healId: heal.id,
        status: "completed",
        error:
          commitError instanceof Error
            ? commitError.message
            : "Failed to auto-commit",
      };
    }
  }

  return {
    source: result.source,
    healId: heal.id,
    status: "completed",
  };
};

const processFailedResult = async (
  db: Database,
  heal: Heal,
  result: AutofixResultItem
): Promise<ProcessedResult> => {
  await updateHealStatus(db, heal.id, "failed", {
    failedReason: result.error ?? "Autofix failed",
  });

  console.log(
    `[autofix-result] Updated heal ${heal.id} to failed: ${result.error}`
  );

  return {
    source: result.source,
    healId: heal.id,
    status: "failed",
    error: result.error,
  };
};

const processSingleResult = async (
  db: Database,
  result: AutofixResultItem,
  projectId: string,
  prNumber: number,
  orgSettings: Required<OrganizationSettings>,
  autoCommitCtx: AutoCommitContext | null
): Promise<ProcessedResult> => {
  const heal = await getHealByPrAndSource(
    db,
    projectId,
    prNumber,
    result.source
  );

  if (!heal) {
    // No pending/running heal found - may have already been processed (race condition)
    // or never existed. This is not an error, just log and return.
    console.log(
      `[autofix-result] No pending/running heal found for ${result.source} on PR #${prNumber} (may already be processed)`
    );
    return {
      source: result.source,
      healId: null,
      status: "not_found",
      error: "No pending heal found for this source (may already be processed)",
    };
  }

  try {
    if (result.success) {
      return await processSuccessResult(
        db,
        heal,
        result,
        orgSettings,
        autoCommitCtx
      );
    }
    return await processFailedResult(db, heal, result);
  } catch (error) {
    // Handle database constraint violations (e.g., concurrent updates)
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Check for PostgreSQL unique constraint violation or concurrent modification
    if (
      errorMessage.includes("unique constraint") ||
      errorMessage.includes("duplicate key") ||
      errorMessage.includes("concurrent")
    ) {
      console.warn(
        `[autofix-result] Concurrent modification detected for heal ${heal.id}: ${errorMessage}`
      );
      return {
        source: result.source,
        healId: heal.id,
        status: "not_found",
        error: "Heal was modified concurrently",
      };
    }

    // Re-throw other errors
    throw error;
  }
};

// ============================================================================
// Route
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

app.use("*", apiKeyAuthMiddleware);
app.use("*", apiKeyRateLimitMiddleware);

/**
 * POST /
 * Receive autofix results from the GitHub Action.
 *
 * For each result:
 * 1. Find the existing heal record by projectId + prNumber + source
 * 2. Update heal status to completed or failed
 * 3. Store patch and filesChanged
 * 4. If autofixAutoCommit is enabled, push changes to PR
 */
app.post("/", async (c) => {
  const { organizationId } = c.get("apiKeyAuth");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validation = validatePayload(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { projectId, prNumber, results } = validation.payload;

  const { db, client } = await createDb(c.env);
  try {
    // Verify project exists and belongs to the organization
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.removedAt)
      ),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const orgSettings = getOrgSettings(project.organization.settings);
    const github = createGitHubService(c.env);
    const installationId = project.organization.providerInstallationId;

    // Validate repo format is exactly "owner/repo" (no extra slashes)
    const repoFullName = project.providerRepoFullName;
    const slashIndex = repoFullName.indexOf("/");
    if (
      slashIndex === -1 ||
      slashIndex === 0 ||
      slashIndex === repoFullName.length - 1 ||
      repoFullName.indexOf("/", slashIndex + 1) !== -1
    ) {
      console.error(
        `[autofix-result] Invalid repository format: ${repoFullName}`
      );
      return c.json({ error: "Invalid repository format" }, 500);
    }
    const owner = repoFullName.slice(0, slashIndex);
    const repo = repoFullName.slice(slashIndex + 1);

    // Build auto-commit context if installation is available
    const autoCommitCtx: AutoCommitContext | null = installationId
      ? { github, installationId, owner, repo, prNumber }
      : null;

    if (!autoCommitCtx && orgSettings.autofixAutoCommit) {
      console.warn(
        "[autofix-result] Auto-commit enabled but no installation ID for org"
      );
    }

    // Process each result
    const processed: ProcessedResult[] = [];
    for (const result of results) {
      const processedResult = await processSingleResult(
        db,
        result,
        projectId,
        prNumber,
        orgSettings,
        autoCommitCtx
      );
      processed.push(processedResult);
    }

    return c.json({ success: true, received: processed.length, processed });
  } catch (error) {
    console.error("[autofix-result] Error processing results:", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to process results",
      },
      500
    );
  } finally {
    await client.end();
  }
});

export default app;
