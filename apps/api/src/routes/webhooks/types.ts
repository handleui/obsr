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
  }>;
  repositories_removed: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
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

export interface DetentCommand {
  type: "status" | "help" | "unknown";
}

// Variables stored in context by middleware
export interface WebhookVariables {
  webhookPayload:
    | WorkflowRunPayload
    | IssueCommentPayload
    | PingPayload
    | InstallationPayload
    | InstallationRepositoriesPayload
    | RepositoryPayload
    | OrganizationPayload
    | CheckSuitePayload;
}

export type WebhookContext = Context<{
  Bindings: Env;
  Variables: WebhookVariables;
}>;
