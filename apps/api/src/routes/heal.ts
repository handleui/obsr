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
} from "../db/operations/heals";
import { getOrgSettings, heals, projects, runErrors, runs } from "../db/schema";
import { verifyOrgAccess } from "../lib/org-access";
import { captureCheckRunError } from "../lib/sentry";
import { validateUUID } from "../lib/validation";
import { generateAutofixCommitMessage } from "../services/autofix/commit-message";
import { orchestrateHeals } from "../services/autofix/orchestrator";
import { canRunHeal } from "../services/billing";
import { createGitHubService } from "../services/github";
import { getBranchHead, pushHealCommit } from "../services/github/commit-push";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

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
 * POST /:id/trigger
 * Trigger a heal - creates check run and queues heal for processing
 */
app.post("/:id/trigger", async (c) => {
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

    if (heal.status !== "found") {
      return c.json(
        { error: `Cannot trigger heal with status: ${heal.status}` },
        400
      );
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

    const billingCheck = await canRunHeal(c.env, project.organization.id);
    if (!billingCheck.allowed) {
      return c.json(
        { error: billingCheck.reason, code: "BILLING_REQUIRED" },
        402
      );
    }

    // Update heal to pending status FIRST (before external API call)
    // This ensures the heal proceeds even if check run creation fails or API crashes
    await db
      .update(heals)
      .set({
        status: "pending",
        updatedAt: new Date(),
      })
      .where(eq(heals.id, id));

    // Create check run to show healing status on GitHub (non-blocking)
    // If this fails or API crashes, the heal still proceeds - check run is optional UX
    let checkRunId: number | undefined;
    const installationId = project.organization.providerInstallationId;

    if (installationId && heal.commitSha) {
      const [owner, repo] = project.providerRepoFullName.split("/");
      if (owner && repo) {
        try {
          const github = createGitHubService(c.env);
          const token = await github.getInstallationToken(
            Number(installationId)
          );
          const errorCount = heal.errorIds?.length ?? 1;
          const checkRun = await github.createCheckRun(token, {
            owner,
            repo,
            headSha: heal.commitSha,
            name: `Detent Heal: ${heal.autofixSource ?? "AI"}`,
            status: "in_progress",
            output: {
              title: "Healing started",
              summary: `Detent is working on fixing ${errorCount} ${errorCount === 1 ? "error" : "errors"}`,
            },
          });
          checkRunId = checkRun.id;

          // Store checkRunId in separate update (if API crashes here, heal still proceeds)
          await db
            .update(heals)
            .set({
              checkRunId: String(checkRunId),
              updatedAt: new Date(),
            })
            .where(eq(heals.id, id));

          console.log(`[heal] Created check run ${checkRunId} for heal ${id}`);
        } catch (error) {
          // Check run creation failed - heal proceeds without GitHub status indicator
          // Track in Sentry to detect persistent permission issues or API problems
          console.error(
            `[heal] Failed to create check run for heal ${id}:`,
            error
          );
          captureCheckRunError(error, {
            healId: id,
            projectId: heal.projectId,
            owner,
            repo,
            commitSha: heal.commitSha,
            operation: "create",
          });
        }
      }
    }

    return c.json({ success: true, status: "pending", checkRunId });
  } finally {
    await client.end();
  }
});

/**
 * POST /trigger
 * Manually trigger heal for a PR
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestration requires sequential validation steps
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

    // Create check runs for each heal created (after heals are already in pending status)
    // If check run creation fails or API crashes, heals still proceed - check runs are optional UX
    const checkRunIds: Record<string, number> = {};
    if (result.healIds.length > 0 && run.commitSha) {
      const [owner, repo] = project.providerRepoFullName.split("/");
      if (owner && repo) {
        try {
          const github = createGitHubService(c.env);
          const token = await github.getInstallationToken(
            Number.parseInt(installationId, 10)
          );

          for (const healId of result.healIds) {
            try {
              const checkRun = await github.createCheckRun(token, {
                owner,
                repo,
                headSha: run.commitSha,
                name: `Detent Heal: ${type}`,
                status: "in_progress",
                output: {
                  title: "Healing started",
                  summary: `Detent is working on fixing ${errors.length} ${errors.length === 1 ? "error" : "errors"}`,
                },
              });
              checkRunIds[healId] = checkRun.id;

              // Update heal with check run ID
              await db
                .update(heals)
                .set({ checkRunId: String(checkRun.id), updatedAt: new Date() })
                .where(eq(heals.id, healId));

              console.log(
                `[heal] Created check run ${checkRun.id} for heal ${healId}`
              );
            } catch (error) {
              // Track in Sentry to detect persistent permission issues or API problems
              console.error(
                `[heal] Failed to create check run for heal ${healId}:`,
                error
              );
              captureCheckRunError(error, {
                healId,
                projectId: body.projectId,
                owner,
                repo,
                commitSha: run.commitSha,
                operation: "create",
              });
            }
          }
        } catch (error) {
          console.error("[heal] Failed to get installation token:", error);
        }
      }
    }

    return c.json({
      success: true,
      message: `Manual ${type} trigger queued`,
      projectId: body.projectId,
      prNumber: body.prNumber,
      healsCreated: result.healsCreated,
      healIds: result.healIds,
      checkRunIds,
      autofixes: result.autofixes,
    });
  } finally {
    await client.end();
  }
});

export default app;
