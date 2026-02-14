import { createDb, type Db, runErrorOps, runOps } from "@detent/db";
import { getConvexClient } from "../../../db/convex";
import { getHealsByPr, triggerHeal } from "../../../db/operations/heals";
import {
  getOrgSettings,
  type OrganizationSettings,
} from "../../../lib/org-settings";
import { captureWebhookError } from "../../../lib/sentry";
import { orchestrateHeals } from "../../../services/autofix/orchestrator";
import { formatNoHealCandidatesComment } from "../../../services/comment-formatter";
import { createGitHubService } from "../../../services/github";
import { deleteAndPostComment } from "../../../services/github/comments";
import {
  acquireHealCommandLock,
  releaseHealCommandLock,
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

// SECURITY: Patterns that indicate prompt injection attempts
// These patterns attempt to override system instructions or manipulate model behavior
// @internal Exported for testing only
export const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions/i,
  /disregard\s+(previous|all|above|prior)/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+a/i,
  /new\s+instruction[s]?:/i,
  /system\s*prompt/i,
  /\[\[.*system.*\]\]/i, // [[system]] style delimiters
  /```\s*(system|assistant)/i, // Code block role injection
  /<\|.*\|>/i, // Special token patterns like <|im_end|>
  /ASSISTANT:/i,
  /SYSTEM:/i,
  /Human:/i,
];

interface HealProject {
  _id: string;
  organizationId: string;
  removedAt?: number | null;
}

interface HealOrganization {
  providerInstallationId?: string | null;
  settings?: Record<string, unknown> | null;
}

interface HealProjectContext {
  project: HealProject;
  organization: HealOrganization;
}

interface HealRun {
  id: string;
  commitSha?: string | null;
  headBranch?: string | null;
}

interface HealError {
  id: string;
  source?: string | null;
  signatureId?: string | null;
  fixable?: boolean | null;
}

// SECURITY: Control character pattern for sanitization (built from char codes to avoid lint errors)
// Matches: \x00-\x08, \x0B, \x0C, \x0E-\x1F, \x7F (excludes \t=0x09, \n=0x0A, \r=0x0D)
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

// SECURITY: defense-in-depth against prompt injection; model also treats user content as data
// @internal Exported for testing only
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
      return { type: "heal" };
    }

    if (sanitized) {
      return { type: "heal", userInstructions: sanitized };
    }
  }

  return { type: "heal" };
};

const loadHealProjectContext = async (
  c: WebhookContext,
  convex: ReturnType<typeof getConvexClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  repositoryFullName: string
): Promise<HealProjectContext | Response> => {
  const project = (await convex.query("projects:getByRepoFullName", {
    providerRepoFullName: repositoryFullName,
  })) as HealProject | null;

  if (!project || project.removedAt) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "This repository is not connected to Detent."
    );
    return c.json({
      message: "heal command failed",
      reason: "project_not_found",
    });
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as HealOrganization | null;

  if (!organization) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "Organization not found for this repository."
    );
    return c.json({
      message: "heal command failed",
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
): Promise<HealRun | Response> => {
  const run = await runOps.getLatestByProjectPr(db, projectId, prNumber);
  if (!run) {
    await github.postComment(
      token,
      owner,
      repo,
      prNumber,
      "No CI runs found for this PR."
    );
    return c.json({ message: "heal command failed", reason: "no_runs" });
  }

  return run;
};

const loadFixableErrors = async (
  c: WebhookContext,
  db: Db,
  convex: ReturnType<typeof getConvexClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  repositoryFullName: string,
  prNumber: number,
  runId: string
): Promise<HealError[] | Response> => {
  const errors = (await runErrorOps.listFixableByRunId(
    db,
    runId
  )) as HealError[];

  if (errors.length === 0) {
    const commentBody = formatNoHealCandidatesComment();
    const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
    await deleteAndPostComment({
      github,
      token,
      kv: c.env["detent-idempotency"],
      db: convex,
      owner,
      repo,
      repository: repositoryFullName,
      prNumber,
      commentBody,
      appId,
    });
    return c.json({
      message: "heal command completed",
      reason: "no_fixable_errors",
    });
  }

  return errors;
};

const filterActiveHeals = (heals: Awaited<ReturnType<typeof getHealsByPr>>) => {
  return heals.filter(
    (heal) => heal.status === "found" || heal.status === "pending"
  );
};

const maybeCreateMissingHeals = async (
  c: WebhookContext,
  organization: HealOrganization,
  projectId: string,
  prNumber: number,
  run: HealRun,
  errors: HealError[],
  command: DetentCommand,
  repositoryFullName: string
): Promise<Awaited<ReturnType<typeof getHealsByPr>> | Response> => {
  let existingHeals = filterActiveHeals(
    await getHealsByPr(c.env, projectId, prNumber)
  );

  if (existingHeals.length > 0) {
    return existingHeals;
  }

  if (!run.commitSha) {
    return c.json({
      message: "heal command failed",
      reason: "no_commit_sha",
    });
  }

  const installationId = organization.providerInstallationId;
  if (!installationId) {
    return existingHeals;
  }

  const orgSettings = getOrgSettings(
    organization.settings as OrganizationSettings | null | undefined
  );

  console.log(
    `[issue_comment] Creating heals for ${errors.length} errors on PR #${prNumber}`
  );

  const result = await orchestrateHeals({
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

  if (result.healsCreated > 0) {
    console.log(
      `[issue_comment] Created ${result.healsCreated} heals for PR #${prNumber}`
    );
    existingHeals = filterActiveHeals(
      await getHealsByPr(c.env, projectId, prNumber)
    );
  }

  return existingHeals;
};

const handleHealCommand = async (
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

  const convex = getConvexClient(c.env);
  const { db: drizzleDb, pool } = createDb(c.env.DATABASE_URL);

  try {
    const projectContextResult = await loadHealProjectContext(
      c,
      convex,
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
      convex,
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
    const lockResult = await acquireHealCommandLock(kv, project._id, prNumber);
    if (!lockResult.acquired) {
      console.log(
        `[issue_comment] Heal command already processing for PR #${prNumber}, skipping`
      );
      return c.json({
        message: "heal command skipped",
        reason: "concurrent_request",
      });
    }

    try {
      const existingHealsResult = await maybeCreateMissingHeals(
        c,
        organization,
        project._id,
        prNumber,
        run,
        errors,
        command,
        repository.full_name
      );
      if (existingHealsResult instanceof Response) {
        return existingHealsResult;
      }
      const existingHeals = existingHealsResult;

      const healIdsToTrigger = existingHeals
        .filter((h) => h.status === "found")
        .map((h) => h.id);

      if (healIdsToTrigger.length > 0) {
        await Promise.all(
          healIdsToTrigger.map((healId) => triggerHeal(c.env, healId))
        );

        console.log(
          `[issue_comment] Triggered ${healIdsToTrigger.length} heals for PR #${prNumber}`
        );
      }

      const totalHeals = existingHeals.length;

      if (totalHeals === 0) {
        const commentBody = formatNoHealCandidatesComment();
        const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
        await deleteAndPostComment({
          github,
          token,
          kv: c.env["detent-idempotency"],
          db: convex,
          owner,
          repo,
          repository: repository.full_name,
          prNumber,
          commentBody,
          appId,
        });
        return c.json({
          message: "heal command completed",
          reason: "no_heals_available",
          errorCount: errors.length,
        });
      }

      return c.json({
        message: "heal command completed",
        healsTriggered: healIdsToTrigger.length,
        totalHeals,
        errorCount: errors.length,
      });
    } finally {
      await releaseHealCommandLock(kv, project._id, prNumber);
    }
  } catch (error) {
    console.error(
      "[issue_comment] Heal command error:",
      error instanceof Error ? error.message : String(error)
    );
    return c.json(
      {
        message: "heal command failed",
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

    return handleHealCommand(c, payload, command);
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
