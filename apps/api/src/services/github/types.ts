export interface GitHubServiceConfig {
  appId: string;
  privateKey: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  isExceeded: boolean;
}

export interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

export interface WorkflowRunResponse {
  pull_requests: Array<{ number: number }>;
}

export interface GitTreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  content: string;
}

export interface CreateTreeResponse {
  sha: string;
}

export interface CreateCommitResponse {
  sha: string;
}

export interface RefResponse {
  object: { sha: string };
}

export interface InstallationInfo {
  id: number;
  account: {
    id: number;
    login: string;
    type: "Organization" | "User";
    avatar_url?: string;
  };
  suspended_at: string | null;
}

export interface InstallationReposResponse {
  total_count: number;
  repositories: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
  }>;
}

export interface WorkflowRunsResponse {
  workflow_runs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    run_attempt: number;
    run_started_at: string | null;
    event: string;
  }>;
}

export interface CheckRunResponse {
  id: number;
  html_url: string;
}

export interface CommentResponse {
  id: number;
  html_url: string;
}

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  raw_details?: string;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckRunAnnotation[];
}

// Response from GET /orgs/{org}/members
export interface GitHubOrgMember {
  id: number;
  login: string;
  avatar_url: string;
  type: string;
  site_admin: boolean;
}

// Response from GET /repos/{owner}/{repo}/contents/{path}
// See: https://docs.github.com/en/rest/repos/contents#get-repository-content
export interface GitHubContentsResponse {
  type: "file";
  encoding: string;
  size: number;
  name: string;
  path: string;
  content: string;
  sha: string;
}

// Response from GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
// See: https://docs.github.com/en/rest/actions/workflow-jobs
export interface WorkflowJobsResponse {
  total_count: number;
  jobs: Array<{
    id: number;
    run_id: number;
    name: string;
    status: "queued" | "in_progress" | "completed" | "waiting" | "pending";
    conclusion:
      | "success"
      | "failure"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | null;
    started_at: string | null;
    completed_at: string | null;
    // Additional useful fields from GitHub API
    html_url: string | null;
    workflow_name: string | null;
    head_branch: string | null;
    runner_name: string | null;
    runner_id: number | null;
    // Steps within the job (useful for step-level error tracking)
    steps?: Array<{
      name: string;
      status: "queued" | "in_progress" | "completed";
      conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
      number: number;
      started_at: string | null;
      completed_at: string | null;
    }>;
  }>;
}
