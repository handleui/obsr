import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createDb } from "../../../db/client";
import {
  getOrgSettings,
  heals,
  projects,
  runErrors,
  runs,
} from "../../../db/schema";
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

  const { db, client } = await createDb(c.env);

  try {
    // Find the project by repository full name (with organization for settings)
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.providerRepoFullName, repository.full_name),
        isNull(projects.removedAt)
      ),
      with: { organization: true },
    });

    if (!project) {
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

    // Get the latest run for this PR (include headBranch for orchestration)
    const latestRun = await db
      .select({
        id: runs.id,
        commitSha: runs.commitSha,
        headBranch: runs.headBranch,
      })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.prNumber, prNumber)))
      .orderBy(desc(runs.receivedAt))
      .limit(1);

    const run = latestRun[0];
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

    // Get fixable errors from that run (include fixable for orchestration)
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
      // Post "no heal candidates" comment
      const commentBody = formatNoHealCandidatesComment();
      const appId = Number.parseInt(c.env.GITHUB_APP_ID, 10);
      await deleteAndPostComment({
        github,
        token,
        kv: c.env["detent-idempotency"],
        db,
        owner,
        repo,
        repository: repository.full_name,
        prNumber,
        commentBody,
        appId,
      });
      return c.json({
        message: "heal command completed",
        reason: "no_fixable_errors",
      });
    }

    // Acquire lock to prevent race condition when two heal commands fire simultaneously
    // This ensures only one orchestration runs at a time per PR
    const kv = c.env["detent-idempotency"];
    const lockResult = await acquireHealCommandLock(kv, project.id, prNumber);
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
      // Check for existing pending/found heals for this PR and trigger them
      let existingHeals = await db
        .select({ id: heals.id, status: heals.status })
        .from(heals)
        .where(
          and(
            eq(heals.projectId, project.id),
            eq(heals.prNumber, prNumber),
            inArray(heals.status, ["found", "pending"])
          )
        );

      // If no heals exist yet but we have fixable errors, create them via orchestrateHeals
      // This fixes the logic gap where users see "no fixable errors" when heals haven't been created yet
      if (existingHeals.length === 0 && errors.length > 0) {
        // Cannot orchestrate heals without a commit SHA (needed for check runs and matching)
        if (!run.commitSha) {
          return c.json({
            message: "heal command failed",
            reason: "no_commit_sha",
          });
        }

        const installationId = project.organization.providerInstallationId;
        if (installationId) {
          const orgSettings = getOrgSettings(project.organization.settings);

          console.log(
            `[issue_comment] Creating heals for ${errors.length} errors on PR #${prNumber}`
          );

          const result = await orchestrateHeals({
            env: c.env,
            projectId: project.id,
            runId: run.id,
            commitSha: run.commitSha,
            prNumber,
            branch: run.headBranch ?? "main",
            repoFullName: repository.full_name,
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

            // Re-fetch existing heals after orchestration
            existingHeals = await db
              .select({ id: heals.id, status: heals.status })
              .from(heals)
              .where(
                and(
                  eq(heals.projectId, project.id),
                  eq(heals.prNumber, prNumber),
                  inArray(heals.status, ["found", "pending"])
                )
              );
          }
        }
      }

      // Trigger all found heals by updating their status to pending
      const healIdsToTrigger = existingHeals
        .filter((h) => h.status === "found")
        .map((h) => h.id);

      if (healIdsToTrigger.length > 0) {
        await db
          .update(heals)
          .set({ status: "pending", updatedAt: new Date() })
          .where(inArray(heals.id, healIdsToTrigger));

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
          db,
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
      await releaseHealCommandLock(kv, project.id, prNumber);
    }
  } finally {
    await client.end();
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
