import { type Db, runErrorOps, runOps } from "@obsr/db";
import { getDbClient } from "../../../db/client";
import {
  getResolvesByPr,
  triggerResolve,
} from "../../../db/operations/resolves";
import { getDb } from "../../../lib/db.js";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../../lib/org-settings";
import { captureWebhookError } from "../../../lib/sentry";
import { orchestrateResolves } from "../../../services/autofix/orchestrator";
import { formatNoResolveCandidatesComment } from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import { deleteAndPostComment } from "../../../services/github/comments";
import {
  acquireResolveCommandLock,
  releaseResolveCommandLock,
} from "../../../services/idempotency";
import { classifyError } from "../../../services/webhooks/error-classifier";
import { safeLogValue } from "../../../services/webhooks/types";
import type {
  DetentCommand,
  IssueCommentPayload,
  WebhookContext,
} from "../types";

const DETENTSH_COMMAND_PATTERN = /@detentsh(?:\s+(.*))?/i;

const MAX_USER_INSTRUCTIONS_LENGTH = 500;

export const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions/i,
  /disregard\s+(previous|all|above|prior)/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+a/i,
  /new\s+instruction[s]?:/i,
  /system\s*prompt/i,
  /\[\[.*system.*\]\]/i,
  /```\s*(system|assistant)/i,
  /<\|.*\|>/i,
  /ASSISTANT:/i,
  /SYSTEM:/i,
  /Human:/i,
];

interface ResolveProject {
  _id: string;
  organizationId: string;
  removedAt?: number | null;
}

interface ResolveOrganization {
  providerInstallationId?: string | null;
  settings?: Record<string, unknown> | null;
}

interface ResolveProjectContext {
  project: ResolveProject;
  organization: ResolveOrganization;
}

interface ResolveRun {
  id: string;
  commitSha?: string | null;
  headBranch?: string | null;
}

interface ResolveError {
  id: string;
  source?: string | null;
  signatureId?: string | null;
  fixable?: boolean | null;
}

const buildControlCharPattern = (): RegExp => {
  const parts = [
    "[",
    String.fromCharCode(0x00),
    "-",
    String.fromCharCode(0x08),
    String.fromCharCode(0x0b),
    String.fromCharCode(0x0c),
    String.fromCharCode(0x0e),
    "-",
    String.fromCharCode(0x1f),
    String.fromCharCode(0x7f),
    "]",
  ];
  return new RegExp(parts.join(""), "g");
};
const CONTROL_CHAR_PATTERN = buildControlCharPattern();

export const sanitizeUserInstructions = (
  instructions: string
): { sanitized: string; blocked: boolean } => {
  const truncated = instructions.slice(0, MAX_USER_INSTRUCTIONS_LENGTH);

  if (truncated.includes(String.fromCharCode(0))) {
    console.warn(
      "[issue_comment] Blocked potential encoding attack: null byte detected"
    );
    return { sanitized: "", blocked: true };
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(truncated)) {
      console.warn(
        `[issue_comment] Blocked potential prompt injection: matched pattern ${pattern}`
      );
      return { sanitized: "", blocked: true };
    }
  }

  const cleaned = truncated.replace(CONTROL_CHAR_PATTERN, "");

  return { sanitized: cleaned, blocked: false };
};

const parseDetentCommand = (body: string): DetentCommand | null => {
  const match = body.match(DETENTSH_COMMAND_PATTERN);

  if (!match) {
    return null;
  }

  const instructionsText = match[1]?.trim();

  if (instructionsText) {
    const { sanitized, blocked } = sanitizeUserInstructions(instructionsText);

    if (blocked) {
      return { type: "resolve" };
    }

    if (sanitized) {
      return { type: "resolve", userInstructions: sanitized };
    }
  }

  return { type: "resolve" };
};

const loadResolveProjectContext = async (
  c: WebhookContext,
  dbClient: ReturnType<typeof getDbClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  repositoryFullName: string
): Promise<ResolveProjectContext | Response> => {
  const project = (await dbClient.query("projects:getByRepoFullName", {
    providerRepoFullName: repositoryFullName,
  })) as ResolveProject | null;

  if (!project || project.removedAt) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "This repository is not connected to Detent."
    );
    return c.json({
      message: "resolve command failed",
      reason: "project_not_found",
    });
  }

  const organization = (await dbClient.query("organizations:getById", {
    id: project.organizationId,
  })) as ResolveOrganization | null;

  if (!organization) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "Organization not found for this repository."
    );
    return c.json({
      message: "resolve command failed",
      reason: "organization_not_found",
    });
  }

  return { project, organization };
};

const loadLatestRun = async (
  c: WebhookContext,
  db: Db,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  projectId: string
): Promise<ResolveRun | Response> => {
  const run = await runOps.getLatestByProjectPr(db, projectId, prNumber);
  if (!run) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "No CI runs found for this PR."
    );
    return c.json({ message: "resolve command failed", reason: "no_runs" });
  }

  return run;
};

const loadFixableErrors = async (
  c: WebhookContext,
  db: Db,
  dbClient: ReturnType<typeof getDbClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  repositoryFullName: string,
  prNumber: number,
  runId: string
): Promise<ResolveError[] | Response> => {
  const errors = await runErrorOps.listFixableSummariesByRunId(db, runId);
  const normalizedErrors = errors.map((error) => ({
    id: error.id,
    source: error.source,
    signatureId: error.signatureId,
    fixable: true,
  }));

  if (normalizedErrors.length === 0) {
    const commentBody = formatNoResolveCandidatesComment();
    const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
    await deleteAndPostComment({
      github,
      token,
      kv: c.env["detent-idempotency"],
      db: dbClient,
      owner,
      repo,
      repository: repositoryFullName,
      prNumber,
      commentBody,
      appId,
    });
    return c.json({
      message: "resolve command completed",
      reason: "no_fixable_errors",
    });
  }

  return normalizedErrors;
};

const filterActiveResolves = (
  resolves: Awaited<ReturnType<typeof getResolvesByPr>>
) => {
  return resolves.filter(
    (resolve) => resolve.status === "found" || resolve.status === "pending"
  );
};

const maybeCreateMissingResolves = async (
  c: WebhookContext,
  organization: ResolveOrganization,
  projectId: string,
  prNumber: number,
  run: ResolveRun,
  errors: ResolveError[],
  command: DetentCommand,
  repositoryFullName: string
): Promise<Awaited<ReturnType<typeof getResolvesByPr>> | Response> => {
  let existingResolves = filterActiveResolves(
    await getResolvesByPr(c.env, projectId, prNumber)
  );

  if (existingResolves.length > 0) {
    return existingResolves;
  }

  if (!run.commitSha) {
    return c.json({
      message: "resolve command failed",
      reason: "no_commit_sha",
    });
  }

  const installationId = organization.providerInstallationId;
  if (!installationId) {
    return existingResolves;
  }

  const orgSettings = getOrgSettings(
    organization.settings as OrganizationSettings | null | undefined
  );

  console.log(
    `[issue_comment] Creating resolves for ${errors.length} errors on PR #${prNumber}`
  );

  const result = await orchestrateResolves({
    env: c.env,
    projectId,
    runId: run.id,
    commitSha: run.commitSha,
    prNumber,
    branch: run.headBranch ?? "main",
    repoFullName: repositoryFullName,
    installationId: Number.parseInt(installationId, 10),
    errors: errors.map((e) => ({
      id: e.id,
      source: e.source ?? undefined,
      signatureId: e.signatureId ?? undefined,
      fixable: e.fixable ?? false,
    })),
    orgSettings,
    userInstructions: command.userInstructions,
  });

  if (result.resolvesCreated > 0) {
    console.log(
      `[issue_comment] Created ${result.resolvesCreated} resolves for PR #${prNumber}`
    );
    existingResolves = filterActiveResolves(
      await getResolvesByPr(c.env, projectId, prNumber)
    );
  }

  return existingResolves;
};

const handleResolveCommand = async (
  c: WebhookContext,
  payload: IssueCommentPayload,
  command: DetentCommand
): Promise<Response> => {
  const { issue, repository, installation } = payload;
  const prNumber = issue.number;
  const github = createGitHubService(c.env);
  const token = await github.getInstallationToken(installation.id);
  const owner = repository.owner.login;
  const repo = repository.name;

  const dbClient = getDbClient(c.env);
  const { db: drizzleDb, pool } = getDb(c.env);

  try {
    const projectContextResult = await loadResolveProjectContext(
      c,
      dbClient,
      github,
      token,
      owner,
      repo,
      prNumber,
      repository.full_name
    );
    if (projectContextResult instanceof Response) {
      return projectContextResult;
    }
    const { project, organization } = projectContextResult;

    const runResult = await loadLatestRun(
      c,
      drizzleDb,
      github,
      token,
      owner,
      repo,
      prNumber,
      project._id
    );
    if (runResult instanceof Response) {
      return runResult;
    }
    const run = runResult;

    const errorsResult = await loadFixableErrors(
      c,
      drizzleDb,
      dbClient,
      github,
      token,
      owner,
      repo,
      repository.full_name,
      prNumber,
      run.id
    );
    if (errorsResult instanceof Response) {
      return errorsResult;
    }
    const errors = errorsResult;

    const kv = c.env["detent-idempotency"];
    const lockResult = await acquireResolveCommandLock(
      kv,
      project._id,
      prNumber
    );
    if (!lockResult.acquired) {
      console.log(
        `[issue_comment] Resolve command already processing for PR #${prNumber}, skipping`
      );
      return c.json({
        message: "resolve command skipped",
        reason: "concurrent_request",
      });
    }

    try {
      const existingResolvesResult = await maybeCreateMissingResolves(
        c,
        organization,
        project._id,
        prNumber,
        run,
        errors,
        command,
        repository.full_name
      );
      if (existingResolvesResult instanceof Response) {
        return existingResolvesResult;
      }
      const existingResolves = existingResolvesResult;

      const resolveIdsToTrigger = existingResolves
        .filter((h) => h.status === "found")
        .map((h) => h.id);

      if (resolveIdsToTrigger.length > 0) {
        await Promise.all(
          resolveIdsToTrigger.map((resolveId) =>
            triggerResolve(c.env, resolveId)
          )
        );

        console.log(
          `[issue_comment] Triggered ${resolveIdsToTrigger.length} resolves for PR #${prNumber}`
        );
      }

      const totalResolves = existingResolves.length;

      if (totalResolves === 0) {
        const commentBody = formatNoResolveCandidatesComment();
        const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
        await deleteAndPostComment({
          github,
          token,
          kv: c.env["detent-idempotency"],
          db: dbClient,
          owner,
          repo,
          repository: repository.full_name,
          prNumber,
          commentBody,
          appId,
        });
        return c.json({
          message: "resolve command completed",
          reason: "no_resolves_available",
          errorCount: errors.length,
        });
      }

      return c.json({
        message: "resolve command completed",
        resolvesTriggered: resolveIdsToTrigger.length,
        totalResolves,
        errorCount: errors.length,
      });
    } finally {
      await releaseResolveCommandLock(kv, project._id, prNumber);
    }
  } catch (error) {
    console.error(
      "[issue_comment] Resolve command error:",
      error instanceof Error ? error.message : String(error)
    );
    return c.json(
      {
        message: "resolve command failed",
        reason: "internal_error",
      },
      500
    );
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
};

export const handleIssueCommentEvent = async (
  c: WebhookContext,
  payload: IssueCommentPayload
) => {
  const { action, comment, issue, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  if (action !== "created") {
    return c.json({ message: "ignored", reason: "not created" });
  }

  if (!issue.pull_request) {
    return c.json({ message: "ignored", reason: "not a pull request" });
  }

  if (comment.user.type === "Bot") {
    return c.json({ message: "ignored", reason: "bot comment" });
  }

  const body = comment.body.toLowerCase();
  if (!body.includes("@detentsh")) {
    return c.json({ message: "ignored", reason: "no @detentsh mention" });
  }

  console.log(
    `[issue_comment] @detentsh mentioned in ${safeLogValue(repository.full_name)}#${issue.number} by ${safeLogValue(comment.user.login)}`
  );

  const command = parseDetentCommand(comment.body);

  if (!command) {
    return c.json({ message: "ignored", reason: "no valid command" });
  }

  const github = createGitHubService(c.env);

  try {
    const token = await github.getInstallationToken(installation.id);

    await github.addReactionToComment(
      token,
      repository.owner.login,
      repository.name,
      comment.id,
      "eyes"
    );

    return handleResolveCommand(c, payload, command);
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
