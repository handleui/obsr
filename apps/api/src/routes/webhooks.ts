import { Hono } from "hono";
import { webhookSignatureMiddleware } from "../middleware/webhook-signature";
import type { Env } from "../types/env";
import {
  type CheckSuitePayload,
  handleCheckSuiteRequested,
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  handleInstallationTargetEvent,
  handleIssueCommentEvent,
  handleOrganizationEvent,
  handleRepositoryEvent,
  handleWorkflowJobCompleted,
  handleWorkflowJobInProgress,
  handleWorkflowJobQueued,
  handleWorkflowJobWaiting,
  handleWorkflowRunCompleted,
  handleWorkflowRunInProgress,
  type InstallationPayload,
  type InstallationRepositoriesPayload,
  type InstallationTargetPayload,
  type IssueCommentPayload,
  type OrganizationPayload,
  type PingPayload,
  type RepositoryPayload,
  type WebhookContext,
  type WebhookVariables,
  type WorkflowJobPayload,
  type WorkflowRunPayload,
} from "./webhooks/index";

// Re-export ERROR_CODES for backwards compatibility
// biome-ignore lint/performance/noBarrelFile: Backwards compatibility re-exports
export { ERROR_CODES, type ErrorCode } from "./webhooks/index";

const app = new Hono<{ Bindings: Env; Variables: WebhookVariables }>();

// GitHub webhook endpoint
// Receives: workflow_run, issue_comment, check_suite events
// Note: workflow_run.in_progress posts the "waiting" comment early when CI starts
app.post("/github", webhookSignatureMiddleware, (c: WebhookContext) => {
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");
  const payload = c.get("webhookPayload");

  console.log(`[webhook] Received ${event} event (delivery: ${deliveryId})`);

  // Route by event type
  switch (event) {
    case "workflow_run": {
      const workflowPayload = payload as WorkflowRunPayload;
      // Route based on action type
      if (workflowPayload.action === "in_progress") {
        return handleWorkflowRunInProgress(c, workflowPayload);
      }
      if (workflowPayload.action === "completed") {
        return handleWorkflowRunCompleted(c, workflowPayload);
      }
      // Ignore other actions (requested, etc.)
      return c.json({
        message: "ignored",
        reason: `action ${workflowPayload.action} not handled`,
      });
    }

    case "issue_comment":
      return handleIssueCommentEvent(c, payload as IssueCommentPayload);

    case "ping":
      // GitHub sends this when webhook is first configured
      return c.json({ message: "pong", zen: (payload as PingPayload).zen });

    case "installation":
      return handleInstallationEvent(c, payload as InstallationPayload);

    case "installation_repositories":
      return handleInstallationRepositoriesEvent(
        c,
        payload as InstallationRepositoriesPayload
      );

    case "installation_target":
      return handleInstallationTargetEvent(
        c,
        payload as InstallationTargetPayload
      );

    case "repository":
      return handleRepositoryEvent(c, payload as RepositoryPayload);

    case "organization":
      return handleOrganizationEvent(c, payload as OrganizationPayload);

    case "check_suite":
      return handleCheckSuiteRequested(c, payload as CheckSuitePayload);

    case "workflow_job": {
      const jobPayload = payload as WorkflowJobPayload;
      switch (jobPayload.action) {
        case "queued":
          return handleWorkflowJobQueued(c, jobPayload);
        case "in_progress":
          return handleWorkflowJobInProgress(c, jobPayload);
        case "completed":
          return handleWorkflowJobCompleted(c, jobPayload);
        case "waiting":
          return handleWorkflowJobWaiting(c, jobPayload);
        default:
          return c.json({
            message: "ignored",
            reason: `action ${jobPayload.action} not handled`,
          });
      }
    }

    default:
      console.log(`[webhook] Ignoring unhandled event: ${event}`);
      return c.json({ message: "ignored", event });
  }
});

export default app;
