/**
 * Heals API routes
 *
 * Manages autofix and AI heal operations for CI errors.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import {
  applyHeal,
  getHealById,
  getHealsByPr,
  getPendingHeals,
  type HealRecord,
  rejectHeal,
  triggerHeal,
} from "../db/operations/heals";
import { verifyOrgAccess } from "../lib/org-access";
import { getOrgSettings } from "../lib/org-settings";
import { generateAutofixCommitMessage } from "../services/autofix/commit-message";
import { orchestrateHeals } from "../services/autofix/orchestrator";
import { canRunHeal } from "../services/billing";
import { createGitHubService } from "../services/github";
import { getBranchHead, pushHealCommit } from "../services/github/commit-push";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

interface ProjectDoc {
  _id: string;
  organizationId: string;
  providerRepoFullName: string;
  providerDefaultBranch?: string;
  removedAt?: number;
}

interface OrganizationDoc {
  _id: string;
  name: string;
  slug: string;
  provider: "github" | "gitlab";
  providerAccountLogin: string;
  providerAccountId: string;
  providerAccountType: "organization" | "user";
  providerInstallationId?: string;
  installerGithubId?: string;
  suspendedAt?: number;
  deletedAt?: number;
  settings?: Record<string, unknown> | null;
}

interface RunDoc {
  _id: string;
  commitSha?: string;
  headBranch?: string;
  prNumber?: number;
  receivedAt: number;
}

interface RunErrorDoc {
  _id: string;
  source?: string;
  signatureId?: string;
  fixable?: boolean;
}

const validateHealId = (
  id: string,
  fieldName = "id"
): { valid: boolean; error?: string } => {
  if (!id || typeof id !== "string") {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (id.length > 128) {
    return { valid: false, error: `${fieldName} is too long` };
  }
  return { valid: true };
};

const loadHealApplyContext = async (
  c: Context<{ Bindings: Env }>,
  convex: ReturnType<typeof getConvexClient>,
  healId: string,
  userId: string
): Promise<
  | {
      heal: HealRecord;
      project: ProjectDoc;
      organization: OrganizationDoc;
    }
  | Response
> => {
  const heal = await getHealById(c.env, healId);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  const project = (await convex.query("projects:getById", {
    id: heal.projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  return { heal, project, organization };
};

const getApplyInputs = (
  c: Context<{ Bindings: Env }>,
  heal: HealRecord,
  project: ProjectDoc,
  organization: OrganizationDoc
):
  | {
      filesChanged: Array<{ path: string; content: string | null }>;
      owner: string;
      repo: string;
      installationId: string;
      prNumber: number;
    }
  | Response => {
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

  const filesChanged = heal.filesChangedWithContent;
  if (!filesChanged || filesChanged.length === 0) {
    return c.json({ error: "Heal has no file changes to apply" }, 400);
  }

  const [owner, repo] = project.providerRepoFullName.split("/");
  if (!(owner && repo)) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const installationId = organization.providerInstallationId;
  if (!installationId) {
    return c.json({ error: "Organization has no GitHub installation" }, 400);
  }

  return {
    filesChanged,
    owner,
    repo,
    installationId,
    prNumber: heal.prNumber,
  };
};

/**
 * GET /
 * List heals for a PR
 *
 * Query params:
 * - projectId: Project ID (required)
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

  const prNumber = Number.parseInt(prNumberStr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getById", {
    id: projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  const heals = await getHealsByPr(c.env, projectId, prNumber);

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
});

/**
 * GET /pending
 * Get all pending heals for a project
 *
 * Query params:
 * - projectId: Project ID (required)
 */
app.get("/pending", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.query("projectId");

  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getById", {
    id: projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  const heals = await getPendingHeals(c.env, projectId);

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
});

/**
 * GET /:id
 * Get heal details
 */
app.get("/:id", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const convex = getConvexClient(c.env);
  const heal = await getHealById(c.env, id);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  const project = (await convex.query("projects:getById", {
    id: heal.projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
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
});

/**
 * POST /:id/apply
 * Apply a heal (push commit to PR)
 */
app.post("/:id/apply", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  try {
    const convex = getConvexClient(c.env);
    const contextResult = await loadHealApplyContext(
      c,
      convex,
      id,
      auth.userId
    );
    if (contextResult instanceof Response) {
      return contextResult;
    }

    const { heal, project, organization } = contextResult;
    const inputs = getApplyInputs(c, heal, project, organization);
    if (inputs instanceof Response) {
      return inputs;
    }

    const { filesChanged, owner, repo, installationId, prNumber } = inputs;

    const github = createGitHubService(c.env);
    const token = await github.getInstallationToken(
      Number.parseInt(installationId, 10)
    );

    // Get PR info to find the branch name and current head SHA
    const prInfo = await github.getPullRequestInfo(
      token,
      owner,
      repo,
      prNumber
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
        heal.autofixSource ?? null,
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
    await applyHeal(c.env, id, result.sha);

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
  }
});

/**
 * POST /:id/reject
 * Reject a heal
 */
app.post("/:id/reject", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
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

  const convex = getConvexClient(c.env);
  const heal = await getHealById(c.env, id);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  const project = (await convex.query("projects:getById", {
    id: heal.projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  if (heal.status === "applied") {
    return c.json({ error: "Cannot reject an already applied heal" }, 400);
  }

  // Use auth.userId as rejectedBy
  await rejectHeal(c.env, id, auth.userId, body.reason);

  return c.json({ success: true, message: "Heal rejected" });
});

/**
 * POST /:id/trigger
 * Trigger a heal - sets status to pending for Healer to process
 */
app.post("/:id/trigger", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const convex = getConvexClient(c.env);
  const heal = await getHealById(c.env, id);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  if (heal.status !== "found") {
    return c.json(
      { error: `Cannot trigger heal with status: ${heal.status}` },
      400
    );
  }

  const project = (await convex.query("projects:getById", {
    id: heal.projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  const billingCheck = await canRunHeal(c.env, organization._id);
  if (!billingCheck.allowed) {
    return c.json(
      { error: billingCheck.reason, code: "BILLING_REQUIRED" },
      402
    );
  }

  // Update heal to pending status - Healer will create check run when it starts processing
  await triggerHeal(c.env, id);

  return c.json({ success: true, status: "pending" });
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

  if (typeof body.prNumber !== "number" || body.prNumber <= 0) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const type = body.type ?? "autofix";
  if (type !== "autofix" && type !== "heal") {
    return c.json({ error: "type must be 'autofix' or 'heal'" }, 400);
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getById", {
    id: body.projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  // Get organization settings
  const orgSettings = getOrgSettings(organization.settings);

  // Get the latest run for this PR
  const run = (await convex.query("runs:getLatestByProjectPr", {
    projectId: body.projectId,
    prNumber: body.prNumber,
  })) as RunDoc | null;
  if (!run) {
    return c.json({ error: "No runs found for this PR" }, 404);
  }

  // Get fixable errors from that run
  const runErrors = (await convex.query("run_errors:listByRunId", {
    runId: run._id,
    limit: 1000,
  })) as RunErrorDoc[];
  const fixableErrors = runErrors.filter((error) => error.fixable);

  if (fixableErrors.length === 0) {
    return c.json({ error: "No fixable errors found for this PR" }, 400);
  }

  // Get installation ID from the organization
  const installationId = organization.providerInstallationId;
  if (!installationId) {
    return c.json(
      { error: "No GitHub installation found for organization" },
      400
    );
  }

  // Call orchestrateHeals with proper context
  // Healer will create check runs when it starts processing each heal
  const result = await orchestrateHeals({
    env: c.env,
    projectId: body.projectId,
    runId: run._id,
    commitSha: run.commitSha ?? "",
    prNumber: body.prNumber,
    branch: run.headBranch ?? "main",
    repoFullName: project.providerRepoFullName,
    installationId: Number.parseInt(installationId, 10),
    errors: fixableErrors.map((e) => ({
      id: e._id,
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
    autofixes: result.autofixes,
  });
});

export default app;
