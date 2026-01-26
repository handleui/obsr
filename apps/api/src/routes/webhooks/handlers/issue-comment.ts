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
import {
  formatHealingComment,
  formatNoHealCandidatesComment,
} from "../../../services/comment-formatter";
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

// Parse @detent commands from comment body
const parseDetentCommand = (body: string): DetentCommand => {
  const lower = body.toLowerCase();

  // Check heal first (more specific command)
  if (lower.includes("@detent heal")) {
    return { type: "heal" };
  }

  if (lower.includes("@detent status")) {
    return { type: "status" };
  }

  if (lower.includes("@detent help")) {
    return { type: "help" };
  }

  return { type: "unknown" };
};

// Format help message
const formatHelpMessage = (): string => {
  return `**Available commands:**
- \`@detent heal\` - Trigger AI healing for fixable errors
- \`@detent status\` - Show current error status
- \`@detent help\` - Show this message`;
};

// Handle @detent heal command
const handleHealCommand = async (
  c: WebhookContext,
  payload: IssueCommentPayload
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
        });
        return c.json({
          message: "heal command completed",
          reason: "no_heals_available",
          errorCount: errors.length,
        });
      }

      // Post "healing" comment
      const commentBody = formatHealingComment({ errorCount: errors.length });
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
      });

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

// Handle issue_comment events (@detent mentions)
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

  // Check for @detent mention
  const body = comment.body.toLowerCase();
  if (!body.includes("@detent")) {
    return c.json({ message: "ignored", reason: "no @detent mention" });
  }

  console.log(
    `[issue_comment] @detent mentioned in ${repository.full_name}#${issue.number} by ${comment.user.login}`
  );

  // Parse command
  const command = parseDetentCommand(comment.body);

  // Get GitHub service
  const github = createGitHubService(c.env);

  try {
    // Get installation token
    const token = await github.getInstallationToken(installation.id);

    switch (command.type) {
      case "heal": {
        return handleHealCommand(c, payload);
      }

      case "status": {
        // Future: Report current error status from stored analysis
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          "Status check is not yet implemented."
        );
        return c.json({
          message: "status command received",
          status: "not_implemented",
        });
      }

      case "help": {
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          formatHelpMessage()
        );
        return c.json({ message: "help command received", status: "posted" });
      }

      default: {
        await github.postComment(
          token,
          repository.owner.login,
          repository.name,
          issue.number,
          `Unknown command. ${formatHelpMessage()}`
        );
        return c.json({ message: "unknown command", status: "posted" });
      }
    }
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
