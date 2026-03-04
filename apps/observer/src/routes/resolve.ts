import { type createDb, runErrorOps, runOps } from "@detent/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import {
  applyResolve,
  getPendingResolves,
  getResolveById,
  getResolvesByPr,
  type ResolveRecord,
  rejectResolve,
  triggerResolve,
} from "../db/operations/resolves";
import { getDb } from "../lib/db.js";
import { verifyOrgAccess } from "../lib/org-access";
import { getOrgSettings } from "../lib/org-settings";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch";
import { generateAutofixCommitMessage } from "../services/autofix/commit-message";
import { orchestrateResolves } from "../services/autofix/orchestrator";
import { canRunResolve } from "../services/billing";
import { createGitHubService } from "../services/github";
import {
  getBranchHead,
  pushResolveCommit,
} from "../services/github/commit-push";
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

const validateResolveId = (
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

const loadResolveApplyContext = async (
  c: Context<{ Bindings: Env }>,
  convex: ReturnType<typeof getConvexClient>,
  resolveId: string,
  userId: string
): Promise<
  | {
      resolve: ResolveRecord;
      project: ProjectDoc;
      organization: OrganizationDoc;
    }
  | Response
> => {
  const resolve = await getResolveById(c.env, resolveId);
  if (!resolve) {
    return c.json({ error: "Resolve not found" }, 404);
  }

  const project = (await convex.query("projects:getById", {
    id: resolve.projectId,
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

  return { resolve, project, organization };
};

const getApplyInputs = (
  c: Context<{ Bindings: Env }>,
  resolve: ResolveRecord,
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
  if (resolve.status !== "completed") {
    return c.json(
      { error: `Cannot apply resolve with status: ${resolve.status}` },
      400
    );
  }

  if (!resolve.patch) {
    return c.json({ error: "Resolve has no patch to apply" }, 400);
  }

  if (!resolve.prNumber) {
    return c.json({ error: "Resolve has no PR number" }, 400);
  }

  const filesChanged = resolve.filesChangedWithContent;
  if (!filesChanged || filesChanged.length === 0) {
    return c.json({ error: "Resolve has no file changes to apply" }, 400);
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
    prNumber: resolve.prNumber,
  };
};

const formatResolveResponse = (h: ResolveRecord) => ({
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
  resolveResult: h.resolveResult,
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

  const resolves = await getResolvesByPr(c.env, projectId, prNumber);

  return c.json({ resolves: resolves.map(formatResolveResponse) });
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

  const resolves = await getPendingResolves(c.env, projectId);

  return c.json({
    resolves: resolves.map((h) => ({
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

  const validation = validateResolveId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const resolve = await getResolveById(c.env, id);
  if (!resolve) {
    return c.json({ error: "Resolve not found" }, 404);
  }

  const result = await verifyProjectAccess(c, auth.userId, resolve.projectId);
  if (result instanceof Response) {
    return result;
  }

  return c.json({
    resolve: {
      ...formatResolveResponse(resolve),
      runId: resolve.runId,
      projectId: resolve.projectId,
    },
  });
});

const pushResolveToGitHub = async (
  c: Context<{ Bindings: Env }>,
  resolve: ResolveRecord,
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
    resolve.commitMessage ??
    generateAutofixCommitMessage(
      resolve.autofixSource ?? null,
      resolve.errorIds?.length ?? 0
    );

  return await pushResolveCommit({
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

  const validation = validateResolveId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  try {
    const convex = getConvexClient(c.env);
    const contextResult = await loadResolveApplyContext(
      c,
      convex,
      id,
      auth.userId
    );
    if (contextResult instanceof Response) {
      return contextResult;
    }

    const { resolve, project, organization } = contextResult;

    if (resolve.appliedAt) {
      return c.json({
        success: true,
        sha: resolve.appliedCommitSha,
        alreadyApplied: true,
      });
    }

    const inputs = getApplyInputs(c, resolve, project, organization);
    if (inputs instanceof Response) {
      return inputs;
    }

    const pushResult = await pushResolveToGitHub(c, resolve, inputs);
    if (pushResult instanceof Response) {
      return pushResult;
    }

    await applyResolve(c.env, id, pushResult.sha);

    if (c.env.ENCRYPTION_KEY) {
      c.executionCtx.waitUntil(
        dispatchWebhookEvent(
          convex,
          c.env.ENCRYPTION_KEY,
          organization._id,
          "resolve.applied",
          {
            resolve_id: id,
            type: resolve.type,
            status: "applied",
            project_id: resolve.projectId,
            pr_number: resolve.prNumber ?? null,
            commit_sha: resolve.commitSha ?? null,
            applied_commit_sha: pushResult.sha ?? null,
            patch: resolve.patch ?? null,
            files_changed: resolve.filesChanged ?? null,
          }
        )
      );
    }

    console.log(
      `[resolve] Applied resolve ${id} to ${inputs.owner}/${inputs.repo}#${resolve.prNumber}`
    );

    return c.json({
      success: true,
      message: "Resolve applied",
      commitSha: pushResult.sha,
      commitUrl: pushResult.url,
    });
  } catch (error) {
    console.error(`[resolve] Failed to apply resolve ${id}:`, error);
    return c.json({ error: "Failed to apply resolve" }, 500);
  }
});

app.post("/:id/reject", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateResolveId(id, "id");
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

  const resolve = await getResolveById(c.env, id);
  if (!resolve) {
    return c.json({ error: "Resolve not found" }, 404);
  }

  const result = await verifyProjectAccess(c, auth.userId, resolve.projectId);
  if (result instanceof Response) {
    return result;
  }

  if (resolve.status !== "completed") {
    return c.json(
      { error: `Cannot reject resolve with status: ${resolve.status}` },
      400
    );
  }

  await rejectResolve(c.env, id, auth.userId, body.reason);

  if (c.env.ENCRYPTION_KEY) {
    const convex = getConvexClient(c.env);
    c.executionCtx.waitUntil(
      dispatchWebhookEvent(
        convex,
        c.env.ENCRYPTION_KEY,
        result.organization._id,
        "resolve.rejected",
        {
          resolve_id: id,
          type: resolve.type,
          status: "rejected",
          project_id: resolve.projectId,
          pr_number: resolve.prNumber ?? null,
          commit_sha: resolve.commitSha ?? null,
        }
      )
    );
  }

  return c.json({ success: true, message: "Resolve rejected" });
});

app.post("/:id/trigger", async (c) => {
  const auth = c.get("auth");
  const { id } = c.req.param();

  const validation = validateResolveId(id, "id");
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const resolve = await getResolveById(c.env, id);
  if (!resolve) {
    return c.json({ error: "Resolve not found" }, 404);
  }

  if (resolve.status !== "found") {
    return c.json(
      { error: `Cannot trigger resolve with status: ${resolve.status}` },
      400
    );
  }

  const result = await verifyProjectAccess(c, auth.userId, resolve.projectId);
  if (result instanceof Response) {
    return result;
  }

  const billingCheck = await canRunResolve(c.env, result.organization._id);
  if (!billingCheck.allowed) {
    return c.json(
      { error: billingCheck.reason, code: "BILLING_REQUIRED" },
      402
    );
  }

  await triggerResolve(c.env, id);

  if (c.env.ENCRYPTION_KEY) {
    const convex = getConvexClient(c.env);
    c.executionCtx.waitUntil(
      dispatchWebhookEvent(
        convex,
        c.env.ENCRYPTION_KEY,
        result.organization._id,
        "resolve.pending",
        {
          resolve_id: id,
          type: resolve.type,
          status: "pending",
          project_id: resolve.projectId,
          pr_number: resolve.prNumber ?? null,
          commit_sha: resolve.commitSha ?? null,
        }
      )
    );
  }

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
  if (type !== "autofix" && type !== "resolve") {
    return c.json({ error: "type must be 'autofix' or 'resolve'" }, 400);
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

    const orchestrationResult = await orchestrateResolves({
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
      resolvesCreated: orchestrationResult.resolvesCreated,
      resolveIds: orchestrationResult.resolveIds,
      autofixes: orchestrationResult.autofixes,
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});

export default app;
