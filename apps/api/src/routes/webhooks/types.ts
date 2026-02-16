import type { Context } from "hono";
import type { Env } from "../../types/env";

// Type definitions for GitHub webhook payloads
export interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    head_commit?: {
      message: string;
    };
    pull_requests: Array<{ number: number }>;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation: { id: number };
}

export interface IssueCommentPayload {
  action: string;
  comment: {
    id: number;
    body: string;
    user: { login: string; type: string };
  };
  issue: {
    number: number;
    pull_request?: { url: string };
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation: { id: number };
}

export interface PingPayload {
  zen: string;
  hook_id: number;
}

export interface InstallationPayload {
  action:
    | "created"
    | "deleted"
    | "suspend"
    | "unsuspend"
    | "new_permissions_accepted";
  installation: {
    id: number;
    account: {
      id: number;
      login: string;
      type: "Organization" | "User";
      avatar_url?: string;
    };
  };
  // The user who triggered the webhook event (installer for "created" action)
  sender: {
    id: number;
    login: string;
    type: "User";
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  }>;
}

export interface InstallationRepositoriesPayload {
  action: "added" | "removed";
  installation: {
    id: number;
    account: {
      id: number;
      login: string;
      type: "Organization" | "User";
    };
  };
  repositories_added: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  }>;
  repositories_removed: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  }>;
}

export interface RepositoryPayload {
  action: "renamed" | "transferred" | "privatized" | "publicized";
  repository: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
  };
  changes?: {
    repository?: {
      name?: { from: string };
    };
  };
  installation?: { id: number };
}

export interface OrganizationPayload {
  action: "renamed" | "member_added" | "member_removed" | "member_invited";
  organization: {
    id: number;
    login: string;
    avatar_url?: string;
  };
  membership?: {
    user: {
      id: number;
      login: string;
    };
    role: string;
  };
  changes?: {
    login?: {
      from: string;
    };
  };
  installation?: { id: number };
}

export interface InstallationTargetPayload {
  action: "renamed";
  installation_target: {
    id: number;
    login: string;
    type: "Organization" | "User";
    avatar_url?: string;
  };
  changes?: {
    login?: {
      from: string;
    };
  };
}

export interface CheckSuitePayload {
  action: "requested" | "rerequested" | "completed";
  check_suite: {
    id: number;
    head_sha: string;
    head_branch: string;
    head_commit?: {
      message: string;
    };
    pull_requests: Array<{ number: number; head: { sha: string } }>;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
    private?: boolean;
  };
  installation: { id: number };
}

// ============================================================================
// workflow_job webhook payload (for full CI job visibility)
// ============================================================================

export interface WorkflowJobStep {
  name: string;
  status: "queued" | "in_progress" | "completed" | "pending";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "neutral"
    | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowJobPayload {
  action: "queued" | "in_progress" | "completed" | "waiting";
  workflow_job: {
    id: number;
    run_id: number;
    run_attempt: number;
    run_url: string;
    node_id: string;
    name: string;
    status:
      | "queued"
      | "in_progress"
      | "completed"
      | "waiting"
      | "pending"
      | "requested";
    conclusion:
      | "success"
      | "failure"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "neutral"
      | "stale"
      | "startup_failure"
      | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    head_sha: string;
    head_branch: string | null;
    check_run_url: string;
    runner_id: number | null;
    runner_name: string | null;
    runner_group_id: number | null;
    runner_group_name: string | null;
    workflow_name: string | null;
    html_url: string;
    labels: string[];
    steps?: WorkflowJobStep[];
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation: { id: number };
  sender: {
    id: number;
    login: string;
    type: string;
  };
}

export interface DetentCommand {
  type: "heal";
  userInstructions?: string;
}

// Variables stored in context by middleware
export interface WebhookVariables {
  webhookPayload:
    | WorkflowRunPayload
    | WorkflowJobPayload
    | IssueCommentPayload
    | PingPayload
    | InstallationPayload
    | InstallationRepositoriesPayload
    | RepositoryPayload
    | OrganizationPayload
    | InstallationTargetPayload
    | CheckSuitePayload;
}

export type WebhookContext = Context<{
  Bindings: Env;
  Variables: WebhookVariables;
}>;
