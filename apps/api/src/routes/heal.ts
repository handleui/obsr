import { runErrorOps, runOps } from "@detent/db";
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
import { getDb } from "../lib/db.js";
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

const formatHealResponse = (h: HealRecord) => ({
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
});

const verifyProjectAccess = async (
  c: Context<{ Bindings: Env }>,
  userId: string,
  projectId: string
): Promise<
  { project: ProjectDoc; organization: OrganizationDoc } | Response
> => {
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

  const access = await verifyOrgAccess(userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  return { project, organization };
};

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
  if (Number.isNaN(prNumber) || prNumber <= 0 || prNumber > 2_147_483_647) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const result = await verifyProjectAccess(c, auth.userId, projectId);
  if (result instanceof Response) {
    return result;
  }

  const heals = await getHealsByPr(c.env, projectId, prNumber);

  return c.json({ heals: heals.map(formatHealResponse) });
});

app.get("/pending", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.query("projectId");

  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }

  const result = await verifyProjectAccess(c, auth.userId, projectId);
  if (result instanceof Response) {
    return result;
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

app.get("/:id", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const heal = await getHealById(c.env, id);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  const result = await verifyProjectAccess(c, auth.userId, heal.projectId);
  if (result instanceof Response) {
    return result;
  }

  return c.json({
    heal: {
      ...formatHealResponse(heal),
      runId: heal.runId,
      projectId: heal.projectId,
    },
  });
});

const pushHealToGitHub = async (
  c: Context<{ Bindings: Env }>,
  heal: HealRecord,
  inputs: {
    filesChanged: Array<{ path: string; content: string | null }>;
    owner: string;
    repo: string;
    installationId: string;
    prNumber: number;
  }
) => {
  const { filesChanged, owner, repo, installationId, prNumber } = inputs;

  const github = createGitHubService(c.env);
  const token = await github.getInstallationToken(
    Number.parseInt(installationId, 10)
  );

  const prInfo = await github.getPullRequestInfo(token, owner, repo, prNumber);
  if (!prInfo) {
    return c.json({ error: "PR not found" }, 404);
  }

  const baseSha = await getBranchHead(token, owner, repo, prInfo.headBranch);
  const commitMessage =
    heal.commitMessage ??
    generateAutofixCommitMessage(
      heal.autofixSource ?? null,
      heal.errorIds?.length ?? 0
    );

  return await pushHealCommit({
    token,
    owner,
    repo,
    branch: prInfo.headBranch,
    baseSha,
    filesChanged,
    commitMessage,
    verifyBaseSha: true,
  });
};

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

    if (heal.appliedAt) {
      return c.json({
        success: true,
        sha: heal.appliedCommitSha,
        alreadyApplied: true,
      });
    }

    const inputs = getApplyInputs(c, heal, project, organization);
    if (inputs instanceof Response) {
      return inputs;
    }

    const pushResult = await pushHealToGitHub(c, heal, inputs);
    if (pushResult instanceof Response) {
      return pushResult;
    }

    await applyHeal(c.env, id, pushResult.sha);

    console.log(
      `[heal] Applied heal ${id} to ${inputs.owner}/${inputs.repo}#${heal.prNumber}`
    );

    return c.json({
      success: true,
      message: "Heal applied",
      commitSha: pushResult.sha,
      commitUrl: pushResult.url,
    });
  } catch (error) {
    console.error(`[heal] Failed to apply heal ${id}:`, error);
    return c.json({ error: "Failed to apply heal" }, 500);
  }
});

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

  const heal = await getHealById(c.env, id);
  if (!heal) {
    return c.json({ error: "Heal not found" }, 404);
  }

  const result = await verifyProjectAccess(c, auth.userId, heal.projectId);
  if (result instanceof Response) {
    return result;
  }

  if (heal.status !== "completed") {
    return c.json(
      { error: `Cannot reject heal with status: ${heal.status}` },
      400
    );
  }

  await rejectHeal(c.env, id, auth.userId, body.reason);

  return c.json({ success: true, message: "Heal rejected" });
});

app.post("/:id/trigger", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateHealId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

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

  const result = await verifyProjectAccess(c, auth.userId, heal.projectId);
  if (result instanceof Response) {
    return result;
  }

  const billingCheck = await canRunHeal(c.env, result.organization._id);
  if (!billingCheck.allowed) {
    return c.json(
      { error: billingCheck.reason, code: "BILLING_REQUIRED" },
      402
    );
  }

  await triggerHeal(c.env, id);

  return c.json({ success: true, status: "pending" });
});

interface TriggerBody {
  projectId?: string;
  prNumber?: number;
  type?: string;
}

const parseTriggerBody = async (
  c: Context<{ Bindings: Env }>
): Promise<TriggerBody | Response> => {
  let body: TriggerBody;
  try {
    body = await c.req.json<TriggerBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.projectId) {
    return c.json({ error: "projectId is required" }, 400);
  }
  if (!body.prNumber) {
    return c.json({ error: "prNumber is required" }, 400);
  }

  if (
    typeof body.prNumber !== "number" ||
    !Number.isInteger(body.prNumber) ||
    body.prNumber <= 0 ||
    body.prNumber > 2_147_483_647
  ) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const type = body.type ?? "autofix";
  if (type !== "autofix" && type !== "heal") {
    return c.json({ error: "type must be 'autofix' or 'heal'" }, 400);
  }

  return { ...body, type };
};

const loadFixableErrors = async (
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof createDb>["db"],
  projectId: string,
  prNumber: number
) => {
  const run = await runOps.getLatestByProjectPr(db, projectId, prNumber);
  if (!run) {
    return c.json({ error: "No runs found for this PR" }, 404);
  }

  const runErrors = await runErrorOps.listByRunId(db, run.id, 1000);
  const fixableErrors = runErrors.filter((e) => e.fixable);

  if (fixableErrors.length === 0) {
    return c.json({ error: "No fixable errors found for this PR" }, 400);
  }

  return { run, fixableErrors };
};

app.post("/trigger", async (c) => {
  const auth = c.get("auth");

  const body = await parseTriggerBody(c);
  if (body instanceof Response) {
    return body;
  }

  const projectId = body.projectId as string;
  const prNumber = body.prNumber as number;
  const type = body.type as string;

  const accessResult = await verifyProjectAccess(c, auth.userId, projectId);
  if (accessResult instanceof Response) {
    return accessResult;
  }

  const { project, organization } = accessResult;
  const installationId = organization.providerInstallationId;
  if (!installationId) {
    return c.json(
      { error: "No GitHub installation found for organization" },
      400
    );
  }

  const { db, pool } = getDb(c.env);
  try {
    const errorResult = await loadFixableErrors(c, db, projectId, prNumber);
    if (errorResult instanceof Response) {
      return errorResult;
    }

    const { run, fixableErrors } = errorResult;
    const orgSettings = getOrgSettings(organization.settings);

    const orchestrationResult = await orchestrateHeals({
      env: c.env,
      projectId,
      runId: run.id,
      commitSha: run.commitSha ?? "",
      prNumber,
      branch: run.headBranch ?? "main",
      repoFullName: project.providerRepoFullName,
      installationId: Number.parseInt(installationId, 10),
      errors: fixableErrors.map((e) => ({
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
      projectId,
      prNumber,
      healsCreated: orchestrationResult.healsCreated,
      healIds: orchestrationResult.healIds,
      autofixes: orchestrationResult.autofixes,
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});

export default app;
