/**
 * Heals API routes
 *
 * Manages autofix and AI heal operations for CI errors.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  applyHeal,
  getHealById,
  getHealsByPr,
  getPendingHeals,
  rejectHeal,
  updateHealStatus,
} from "../db/operations/heals";
import { getOrgSettings, projects, runErrors, runs } from "../db/schema";
import { verifyOrgAccess } from "../lib/org-access";
import { validateUUID } from "../lib/validation";
import { modalWebhookAuthMiddleware } from "../middleware/modal-webhook-auth";
import { generateAutofixCommitMessage } from "../services/autofix/commit-message";
import { orchestrateHeals } from "../services/autofix/orchestrator";
import { createGitHubService } from "../services/github";
import { getBranchHead, pushHealCommit } from "../services/github/commit-push";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

interface AutoCommitContext {
  env: Env;
  db: Awaited<ReturnType<typeof createDb>>["db"];
  healId: string;
  heal: {
    id: string;
    type: "autofix" | "heal";
    projectId: string;
    prNumber: number;
  };
  filesChanged: Array<{ path: string; content: string | null }>;
  commitMessage: string;
}

interface AutoCommitResult {
  applied: boolean;
  commitSha?: string;
}

/**
 * Attempt to auto-commit a heal to the PR branch.
 * Returns result indicating whether the commit was applied.
 *
 * Errors are logged but don't fail the overall webhook processing.
 */
const tryAutoCommitHeal = async (
  ctx: AutoCommitContext
): Promise<AutoCommitResult> => {
  const { env, db, healId, heal, filesChanged, commitMessage } = ctx;

  // Get project with organization to check settings
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, heal.projectId), isNull(projects.removedAt)),
    with: { organization: true },
  });

  if (!project) {
    return { applied: false };
  }

  const orgSettings = getOrgSettings(project.organization.settings);
  const shouldAutoCommit =
    (heal.type === "autofix" && orgSettings.autofixAutoCommit) ||
    (heal.type === "heal" && orgSettings.healAutoCommit);

  if (!shouldAutoCommit) {
    return { applied: false };
  }

  console.log(
    `[heal] Auto-commit enabled for heal ${healId}, pushing to PR #${heal.prNumber}`
  );

  const github = createGitHubService(env);
  const [owner, repo] = project.providerRepoFullName.split("/");

  if (!(owner && repo && project.organization.providerInstallationId)) {
    return { applied: false };
  }

  const token = await github.getInstallationToken(
    Number(project.organization.providerInstallationId)
  );

  // Get current PR branch info (head ref and SHA)
  const prInfo = await github.getPullRequestInfo(
    token,
    owner,
    repo,
    heal.prNumber
  );

  if (!prInfo) {
    console.error(`[heal] Auto-commit failed: PR #${heal.prNumber} not found`);
    return { applied: false };
  }

  // Push the heal commit
  const result = await pushHealCommit({
    token,
    owner,
    repo,
    branch: prInfo.headBranch,
    baseSha: prInfo.headSha,
    filesChanged,
    commitMessage,
    verifyBaseSha: true,
  });

  // Update heal to applied status
  await applyHeal(db, healId, result.sha);
  console.log(`[heal] Auto-committed heal ${heal.id} with SHA ${result.sha}`);

  return { applied: true, commitSha: result.sha };
};

interface ExecutorWebhookPayload {
  healId?: string;
  success?: boolean;
  patch?: string;
  filesChanged?: Array<{ path: string; content: string | null }>;
  error?: string;
}

const validateFilesChanged = (
  filesChanged: Array<{ path: string; content: string | null }>
): { valid: boolean; error?: string } => {
  if (!Array.isArray(filesChanged)) {
    return { valid: false, error: "filesChanged must be an array" };
  }

  if (filesChanged.length > 100) {
    return { valid: false, error: "cannot change more than 100 files" };
  }

  for (const file of filesChanged) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      (file.content !== null && typeof file.content !== "string")
    ) {
      return {
        valid: false,
        error:
          "filesChanged items must have path (string) and content (string or null)",
      };
    }

    if (file.path.length === 0 || file.path.length > 4096) {
      return { valid: false, error: "file path must be 1-4096 characters" };
    }

    if (file.content !== null && file.content.length > 1_000_000) {
      return { valid: false, error: "file content must be under 1MB" };
    }
  }

  // Aggregate size limit (10MB total)
  const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB
  let totalSize = 0;
  for (const file of filesChanged) {
    totalSize += file.content?.length ?? 0;
    if (totalSize > MAX_TOTAL_SIZE) {
      return { valid: false, error: "total content size exceeds 10MB" };
    }
  }

  return { valid: true };
};

const validateExecutorWebhookPayload = (
  body: ExecutorWebhookPayload
): { valid: boolean; error?: string } => {
  if (!body.healId) {
    return { valid: false, error: "healId is required" };
  }

  if (typeof body.success !== "boolean") {
    return { valid: false, error: "success must be a boolean" };
  }

  const uuidValidation = validateUUID(body.healId, "healId");
  if (!uuidValidation.valid) {
    return { valid: false, error: uuidValidation.error };
  }

  if (body.filesChanged) {
    const filesValidation = validateFilesChanged(body.filesChanged);
    if (!filesValidation.valid) {
      return filesValidation;
    }
  }

  if (body.patch && typeof body.patch !== "string") {
    return { valid: false, error: "patch must be a string" };
  }

  if (body.patch && body.patch.length > 5_000_000) {
    return { valid: false, error: "patch must be under 5MB" };
  }

  if (body.error && typeof body.error !== "string") {
    return { valid: false, error: "error must be a string" };
  }

  if (body.error && body.error.length > 10_000) {
    return { valid: false, error: "error message must be under 10KB" };
  }

  return { valid: true };
};

/**
 * GET /
 * List heals for a PR
 *
 * Query params:
 * - projectId: Project UUID (required)
 * - prNumber: PR number (required)
 */
app.get("/", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.query("projectId");
  const prNumberStr = c.req.query("prNumber");

  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }

  if (!prNumberStr) {
    return c.json({ error: "prNumber query parameter is required" }, 400);
  }

  const validation = validateUUID(projectId, "projectId");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const prNumber = Number.parseInt(prNumberStr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    const heals = await getHealsByPr(db, projectId, prNumber);

    return c.json({
      heals: heals.map((h) => ({
        id: h.id,
        type: h.type,
        status: h.status,
        commitSha: h.commitSha,
        prNumber: h.prNumber,
        errorIds: h.errorIds,
        signatureIds: h.signatureIds,
        patch: h.patch,
        commitMessage: h.commitMessage,
        filesChanged: h.filesChanged,
        autofixSource: h.autofixSource,
        autofixCommand: h.autofixCommand,
        healResult: h.healResult,
        costUsd: h.costUsd,
        inputTokens: h.inputTokens,
        outputTokens: h.outputTokens,
        appliedAt: h.appliedAt?.toISOString() ?? null,
        appliedCommitSha: h.appliedCommitSha,
        rejectedAt: h.rejectedAt?.toISOString() ?? null,
        rejectedBy: h.rejectedBy,
        rejectionReason: h.rejectionReason,
        failedReason: h.failedReason,
        createdAt: h.createdAt.toISOString(),
        updatedAt: h.updatedAt.toISOString(),
      })),
    });
  } finally {
    await client.end();
  }
});

/**
 * GET /pending
 * Get all pending heals for a project
 *
 * Query params:
 * - projectId: Project UUID (required)
 */
app.get("/pending", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.query("projectId");

  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }

  const validation = validateUUID(projectId, "projectId");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    const heals = await getPendingHeals(db, projectId);

    return c.json({
      heals: heals.map((h) => ({
        id: h.id,
        type: h.type,
        status: h.status,
        commitSha: h.commitSha,
        prNumber: h.prNumber,
        errorIds: h.errorIds,
        signatureIds: h.signatureIds,
        createdAt: h.createdAt.toISOString(),
        updatedAt: h.updatedAt.toISOString(),
      })),
    });
  } finally {
    await client.end();
  }
});

/**
 * GET /:id
 * Get heal details
 */
app.get("/:id", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateUUID(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const heal = await getHealById(db, id);
    if (!heal) {
      return c.json({ error: "Heal not found" }, 404);
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, heal.projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    return c.json({
      heal: {
        id: heal.id,
        type: heal.type,
        status: heal.status,
        runId: heal.runId,
        projectId: heal.projectId,
        commitSha: heal.commitSha,
        prNumber: heal.prNumber,
        errorIds: heal.errorIds,
        signatureIds: heal.signatureIds,
        patch: heal.patch,
        commitMessage: heal.commitMessage,
        filesChanged: heal.filesChanged,
        autofixSource: heal.autofixSource,
        autofixCommand: heal.autofixCommand,
        healResult: heal.healResult,
        costUsd: heal.costUsd,
        inputTokens: heal.inputTokens,
        outputTokens: heal.outputTokens,
        appliedAt: heal.appliedAt?.toISOString() ?? null,
        appliedCommitSha: heal.appliedCommitSha,
        rejectedAt: heal.rejectedAt?.toISOString() ?? null,
        rejectedBy: heal.rejectedBy,
        rejectionReason: heal.rejectionReason,
        failedReason: heal.failedReason,
        createdAt: heal.createdAt.toISOString(),
        updatedAt: heal.updatedAt.toISOString(),
      },
    });
  } finally {
    await client.end();
  }
});

/**
 * POST /:id/apply
 * Apply a heal (push commit to PR)
 */
app.post("/:id/apply", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateUUID(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const heal = await getHealById(db, id);
    if (!heal) {
      return c.json({ error: "Heal not found" }, 404);
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, heal.projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    if (heal.status !== "completed") {
      return c.json(
        { error: `Cannot apply heal with status: ${heal.status}` },
        400
      );
    }

    if (!heal.patch) {
      return c.json({ error: "Heal has no patch to apply" }, 400);
    }

    if (!heal.prNumber) {
      return c.json({ error: "Heal has no PR number" }, 400);
    }

    // Get file content from filesChangedWithContent (stored when executor completes)
    const filesChanged = heal.filesChangedWithContent;
    if (!filesChanged || filesChanged.length === 0) {
      return c.json({ error: "Heal has no file changes to apply" }, 400);
    }

    // Get repository details from project (format: "owner/repo")
    const [owner, repo] = project.providerRepoFullName.split("/");
    if (!(owner && repo)) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    // Get installation token for GitHub API
    const installationId = project.organization.providerInstallationId;
    if (!installationId) {
      return c.json({ error: "Organization has no GitHub installation" }, 400);
    }

    const github = createGitHubService(c.env);
    const token = await github.getInstallationToken(Number(installationId));

    // Get PR info to find the branch name and current head SHA
    const prInfo = await github.getPullRequestInfo(
      token,
      owner,
      repo,
      heal.prNumber
    );
    if (!prInfo) {
      return c.json({ error: "PR not found" }, 404);
    }

    // Get the current branch head SHA for baseSha
    const baseSha = await getBranchHead(token, owner, repo, prInfo.headBranch);

    // Generate commit message
    const commitMessage =
      heal.commitMessage ??
      generateAutofixCommitMessage(
        heal.autofixSource,
        heal.errorIds?.length ?? 0
      );

    // Push the heal commit
    const result = await pushHealCommit({
      token,
      owner,
      repo,
      branch: prInfo.headBranch,
      baseSha,
      filesChanged,
      commitMessage,
      verifyBaseSha: true,
    });

    // Update heal to applied status with the actual commit SHA
    await applyHeal(db, id, result.sha);

    console.log(
      `[heal] Applied heal ${id} with commit SHA ${result.sha} to ${owner}/${repo}#${heal.prNumber}`
    );

    return c.json({
      success: true,
      message: "Heal applied",
      commitSha: result.sha,
      commitUrl: result.url,
    });
  } catch (error) {
    console.error(`[heal] Failed to apply heal ${id}:`, error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to apply heal",
      },
      500
    );
  } finally {
    await client.end();
  }
});

/**
 * POST /:id/reject
 * Reject a heal
 */
app.post("/:id/reject", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateUUID(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  let body: { reason?: string };
  try {
    body = await c.req.json<{ reason?: string }>();
  } catch {
    body = {};
  }

  if (body.reason && typeof body.reason !== "string") {
    return c.json({ error: "reason must be a string" }, 400);
  }

  if (body.reason && body.reason.length > 1000) {
    return c.json({ error: "reason must be 1000 characters or less" }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const heal = await getHealById(db, id);
    if (!heal) {
      return c.json({ error: "Heal not found" }, 404);
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, heal.projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    if (heal.status === "applied") {
      return c.json({ error: "Cannot reject an already applied heal" }, 400);
    }

    // Use auth.userId as rejectedBy
    await rejectHeal(db, id, auth.userId, body.reason);

    return c.json({ success: true, message: "Heal rejected" });
  } finally {
    await client.end();
  }
});

/**
 * POST /trigger
 * Manually trigger heal for a PR
 */
app.post("/trigger", async (c) => {
  const auth = c.get("auth");

  let body: {
    projectId?: string;
    prNumber?: number;
    type?: string;
  };
  try {
    body = await c.req.json<{
      projectId?: string;
      prNumber?: number;
      type?: string;
    }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.projectId) {
    return c.json({ error: "projectId is required" }, 400);
  }

  if (!body.prNumber) {
    return c.json({ error: "prNumber is required" }, 400);
  }

  const validation = validateUUID(body.projectId, "projectId");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  if (typeof body.prNumber !== "number" || body.prNumber <= 0) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const type = body.type ?? "autofix";
  if (type !== "autofix" && type !== "heal") {
    return c.json({ error: "type must be 'autofix' or 'heal'" }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, body.projectId), isNull(projects.removedAt)),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const access = await verifyOrgAccess(
      db,
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    // Get organization settings
    const orgSettings = getOrgSettings(project.organization.settings);

    // Get the latest run for this PR
    const latestRun = await db
      .select({
        id: runs.id,
        commitSha: runs.commitSha,
        headBranch: runs.headBranch,
      })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, body.projectId),
          eq(runs.prNumber, body.prNumber)
        )
      )
      .orderBy(desc(runs.receivedAt))
      .limit(1);

    const run = latestRun[0];
    if (!run) {
      return c.json({ error: "No runs found for this PR" }, 404);
    }

    // Get fixable errors from that run
    const errors = await db
      .select({
        id: runErrors.id,
        source: runErrors.source,
        signatureId: runErrors.signatureId,
        fixable: runErrors.fixable,
      })
      .from(runErrors)
      .where(and(eq(runErrors.runId, run.id), eq(runErrors.fixable, true)));

    if (errors.length === 0) {
      return c.json({ error: "No fixable errors found for this PR" }, 400);
    }

    // Get installation ID from the organization
    const installationId = project.organization.providerInstallationId;
    if (!installationId) {
      return c.json(
        { error: "No GitHub installation found for organization" },
        400
      );
    }

    // Call orchestrateHeals with proper context
    const result = await orchestrateHeals({
      env: c.env,
      projectId: body.projectId,
      runId: run.id,
      commitSha: run.commitSha ?? "",
      prNumber: body.prNumber,
      branch: run.headBranch ?? "main",
      repoFullName: project.providerRepoFullName,
      installationId: Number.parseInt(installationId, 10),
      errors: errors.map((e) => ({
        id: e.id,
        source: e.source ?? undefined,
        signatureId: e.signatureId ?? undefined,
        fixable: e.fixable ?? false,
      })),
      orgSettings,
    });

    return c.json({
      success: true,
      message: `Manual ${type} trigger queued`,
      projectId: body.projectId,
      prNumber: body.prNumber,
      healsCreated: result.healsCreated,
      healIds: result.healIds,
    });
  } finally {
    await client.end();
  }
});

/**
 * POST /webhook/executor
 * Webhook for Modal executor to report results
 *
 * SECURITY: Protected by HMAC signature verification (X-Modal-Signature header)
 * Signature format: sha256=<hex_digest>
 */
app.post("/webhook/executor", modalWebhookAuthMiddleware, async (c) => {
  const body = c.get("modalWebhookPayload") as ExecutorWebhookPayload;

  const validation = validateExecutorWebhookPayload(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const { db, client } = await createDb(c.env);
  try {
    const heal = await getHealById(db, body.healId as string);
    if (!heal) {
      return c.json({ error: "Resource not found" }, 404);
    }

    if (heal.status !== "pending" && heal.status !== "running") {
      return c.json({ error: "Invalid operation" }, 400);
    }

    if (body.success && body.patch) {
      // Ensure commit message is set (fallback if not set during creation)
      const commitMessage =
        heal.commitMessage ??
        generateAutofixCommitMessage(
          heal.autofixSource,
          heal.errorIds?.length ?? 0
        );

      await updateHealStatus(db, body.healId as string, "completed", {
        patch: body.patch,
        filesChanged: body.filesChanged?.map((f) => f.path),
        filesChangedWithContent: body.filesChanged,
        commitMessage,
      });

      // Try auto-commit if conditions are met (errors are caught and logged)
      const prNumber = heal.prNumber;
      const filesChangedArr = body.filesChanged;
      if (prNumber && filesChangedArr?.length) {
        const autoCommitResult = await tryAutoCommitHeal({
          env: c.env,
          db,
          healId: body.healId as string,
          heal: {
            id: heal.id,
            type: heal.type as "autofix" | "heal",
            projectId: heal.projectId,
            prNumber,
          },
          filesChanged: filesChangedArr,
          commitMessage,
        }).catch((error) => {
          console.error(
            `[heal] Auto-commit failed for heal ${heal.id}:`,
            error
          );
          return { applied: false } as AutoCommitResult;
        });

        if (autoCommitResult.applied) {
          return c.json({
            success: true,
            status: "applied",
            commitSha: autoCommitResult.commitSha,
          });
        }
      }

      return c.json({ success: true, status: "completed" });
    }

    await updateHealStatus(db, body.healId as string, "failed", {
      failedReason: body.error ?? "Unknown error",
    });

    return c.json({ success: true, status: "failed" });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return c.json({ error: "Internal server error" }, 500);
  } finally {
    await client.end();
  }
});

export default app;
