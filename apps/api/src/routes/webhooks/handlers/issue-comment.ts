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
import type {
  DetentCommand,
  IssueCommentPayload,
  WebhookContext,
} from "../types";

// Top-level regex for performance (avoid creating in loops)
const DETENTSH_COMMAND_PATTERN = /@detentsh(?:\s+(.*))?/i;

// Maximum user instructions length for early truncation in webhook handler.
// This is intentionally smaller than the DB layer limit (2000 in heals.ts) because:
// 1. Early truncation reduces payload size through the system
// 2. Shorter instructions are more likely to be actionable
// 3. Limits prompt injection surface area before sanitization
// The DB layer provides a secondary safety net for any paths that bypass this handler.
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
  _id: string;
  commitSha?: string | null;
  headBranch?: string | null;
}

interface HealError {
  _id: string;
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

/**
 * Sanitize user instructions to mitigate prompt injection risks.
 * Returns sanitized string or null if content appears malicious.
 *
 * SECURITY: This is defense-in-depth. The AI model should also be instructed
 * to treat user content as data, not instructions (see SYSTEM_PROMPT).
 *
 * @internal Exported for testing only
 */
export const sanitizeUserInstructions = (
  instructions: string
): { sanitized: string; blocked: boolean } => {
  // Truncate to max length first
  const truncated = instructions.slice(0, MAX_USER_INSTRUCTIONS_LENGTH);

  // SECURITY: Check for null bytes (encoding attacks) first
  if (truncated.includes(String.fromCharCode(0))) {
    console.warn(
      "[issue_comment] Blocked potential encoding attack: null byte detected"
    );
    return { sanitized: "", blocked: true };
  }

  // Check for obvious prompt injection patterns
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(truncated)) {
      console.warn(
        `[issue_comment] Blocked potential prompt injection: matched pattern ${pattern}`
      );
      return { sanitized: "", blocked: true };
    }
  }

  // Remove control characters except newlines, tabs, and carriage returns
  const cleaned = truncated.replace(CONTROL_CHAR_PATTERN, "");

  return { sanitized: cleaned, blocked: false };
};

// Parse @detentsh commands from comment body
const parseDetentCommand = (body: string): DetentCommand | null => {
  // Match @detentsh with optional text after it
  const match = body.match(DETENTSH_COMMAND_PATTERN);

  if (!match) {
    return null;
  }

  // Extract any text after @detentsh as user instructions
  const instructionsText = match[1]?.trim();

  if (instructionsText) {
    // SECURITY: Sanitize user instructions to mitigate prompt injection
    const { sanitized, blocked } = sanitizeUserInstructions(instructionsText);

    if (blocked) {
      // Return command without instructions if blocked
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
  convex: ReturnType<typeof getConvexClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  projectId: string
): Promise<HealRun | Response> => {
  const run = (await convex.query("runs:getLatestByProjectPr", {
    projectId,
    prNumber,
  })) as HealRun | null;
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
  convex: ReturnType<typeof getConvexClient>,
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  repositoryFullName: string,
  prNumber: number,
  runId: string
): Promise<HealError[] | Response> => {
  const errors = (await convex.query("run-errors:listFixableByRunId", {
    runId,
  })) as HealError[];

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
    runId: run._id,
    commitSha: run.commitSha,
    prNumber,
    branch: run.headBranch ?? "main",
    repoFullName: repositoryFullName,
    installationId: Number.parseInt(installationId, 10),
    errors: errors.map((e) => ({
      id: e._id,
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

// Handle @detentsh heal command
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
      convex,
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
      convex,
      github,
      token,
      owner,
      repo,
      repository.full_name,
      prNumber,
      run._id
    );
    if (errorsResult instanceof Response) {
      return errorsResult;
    }
    const errors = errorsResult;

    // Acquire lock to prevent race condition when two heal commands fire simultaneously
    // This ensures only one orchestration runs at a time per PR
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

      // Trigger all found heals by updating their status to pending
      const healIdsToTrigger = existingHeals
        .filter((h) => h.status === "found")
        .map((h) => h.id);

      if (healIdsToTrigger.length > 0) {
        for (const healId of healIdsToTrigger) {
          await triggerHeal(c.env, healId);
        }

        console.log(
          `[issue_comment] Triggered ${healIdsToTrigger.length} heals for PR #${prNumber}`
        );
      }

      const totalHeals = existingHeals.length;

      // If still no heals after orchestration attempt, post "no heal candidates" comment
      // This can happen when autofix is disabled or no errors have matching autofix handlers
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
      // Release the heal command lock
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
  }
};

// Handle issue_comment events (@detentsh mentions)
export const handleIssueCommentEvent = async (
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

  // Check for @detentsh mention
  const body = comment.body.toLowerCase();
  if (!body.includes("@detentsh")) {
    return c.json({ message: "ignored", reason: "no @detentsh mention" });
  }

  console.log(
    `[issue_comment] @detentsh mentioned in ${repository.full_name}#${issue.number} by ${comment.user.login}`
  );

  // Parse command
  const command = parseDetentCommand(comment.body);

  if (!command) {
    return c.json({ message: "ignored", reason: "no valid command" });
  }

  // Get GitHub service
  const github = createGitHubService(c.env);

  try {
    // Get installation token
    const token = await github.getInstallationToken(installation.id);

    // Add eyes reaction to acknowledge the command
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
