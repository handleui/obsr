/**
 * Detent API client for CLI
 *
 * Handles authenticated requests to the Detent API.
 */

const API_BASE_URL = process.env.DETENT_API_URL ?? "https://api.detent.sh";

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  accessToken: string;
  // Additional headers (e.g., X-GitHub-Token for GitHub OAuth token)
  headers?: Record<string, string>;
}

interface ApiError {
  error: string;
}

export class ApiNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiNetworkError";
  }
}

export class ApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiAuthError";
  }
}

export const apiRequest = async <T>(
  path: string,
  options: ApiOptions
): Promise<T> => {
  const { method = "GET", body, accessToken, headers: extraHeaders } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new ApiNetworkError(
        "Network error: Unable to connect to the Detent API. Please check your internet connection."
      );
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiAuthError(
        "Authentication failed. Your session may have expired. Run `dt auth login` to re-authenticate."
      );
    }

    const errorData = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(
      errorData.error ?? `API request failed: ${response.status}`
    );
  }

  return response.json() as Promise<T>;
};

// Organization types
export interface Organization {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  github_org: string;
  role: string;
  github_linked: boolean;
  github_username: string | null;
}

export interface OrganizationsResponse {
  organizations: Organization[];
}

// Organization API methods
export const getOrganizations = (
  accessToken: string
): Promise<OrganizationsResponse> =>
  apiRequest<OrganizationsResponse>("/v1/auth/organizations", { accessToken });

// Auth identity sync types
export interface SyncIdentityResponse {
  user_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  github_synced: boolean;
  github_user_id?: string;
  github_username: string | null;
  organizations_updated?: number;
}

export interface MeResponse {
  user_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  github_linked: boolean;
  github_user_id: string | null;
  github_username: string | null;
}

// Auth API methods
export const syncIdentity = (
  accessToken: string,
  githubToken?: string | null
): Promise<SyncIdentityResponse> =>
  apiRequest<SyncIdentityResponse>("/v1/auth/sync-identity", {
    accessToken,
    method: "POST",
    // Pass GitHub OAuth token if available (used to get user's GitHub ID for installer linking)
    ...(githubToken && { headers: { "X-GitHub-Token": githubToken } }),
  });

export const getMe = (accessToken: string): Promise<MeResponse> =>
  apiRequest<MeResponse>("/v1/auth/me", { accessToken });

// Organization status types
export interface OrgStatusResponse {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  provider: "github" | "gitlab";
  provider_account_login: string;
  provider_account_type: "organization" | "user";
  app_installed: boolean;
  suspended_at: string | null;
  project_count: number;
  created_at: string;
}

export const getOrgStatus = (
  accessToken: string,
  organizationId: string
): Promise<OrgStatusResponse> =>
  apiRequest<OrgStatusResponse>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/status`,
    { accessToken }
  );

// ============================================================================
// Project Types
// ============================================================================

export interface Project {
  project_id: string;
  organization_id: string;
  organization_name?: string;
  organization_slug?: string;
  provider_repo_id: string;
  provider_repo_name: string;
  provider_repo_full_name: string;
  provider_default_branch: string | null;
  is_private: boolean;
  created_at: string;
}

export interface ListProjectsResponse {
  projects: Project[];
}

export interface ProjectDetailsResponse extends Project {
  organization_name: string;
  organization_slug: string;
}

// Project API methods
export const listProjects = (
  accessToken: string,
  organizationId: string
): Promise<ListProjectsResponse> =>
  apiRequest<ListProjectsResponse>(
    `/v1/projects?organization_id=${encodeURIComponent(organizationId)}`,
    { accessToken }
  );

export const getProject = (
  accessToken: string,
  projectId: string
): Promise<ProjectDetailsResponse> =>
  apiRequest<ProjectDetailsResponse>(
    `/v1/projects/${encodeURIComponent(projectId)}`,
    { accessToken }
  );

export const lookupProject = (
  accessToken: string,
  repoFullName: string
): Promise<ProjectDetailsResponse> =>
  apiRequest<ProjectDetailsResponse>(
    `/v1/projects/lookup?repo=${encodeURIComponent(repoFullName)}`,
    { accessToken }
  );

// ============================================================================
// Organization Member Types
// ============================================================================

export interface OrganizationMember {
  user_id: string;
  role: "owner" | "admin" | "member";
  github_linked: boolean;
  github_user_id: string | null;
  github_username: string | null;
  joined_at: string;
}

export interface OrganizationMembersResponse {
  members: OrganizationMember[];
}

export interface LeaveOrganizationResponse {
  success: boolean;
}

// Organization member API methods
export const listOrganizationMembers = (
  accessToken: string,
  organizationId: string
): Promise<OrganizationMembersResponse> =>
  apiRequest<OrganizationMembersResponse>(
    `/v1/organization-members?organization_id=${encodeURIComponent(organizationId)}`,
    { accessToken }
  );

export const leaveOrganization = (
  accessToken: string,
  organizationId: string
): Promise<LeaveOrganizationResponse> =>
  apiRequest<LeaveOrganizationResponse>("/v1/organization-members/leave", {
    accessToken,
    method: "POST",
    body: { organization_id: organizationId },
  });

// ============================================================================
// GitHub Organization Types (for --available flag)
// ============================================================================

export interface GitHubOrgWithStatus {
  id: number;
  login: string;
  avatar_url: string;
  can_install: boolean;
  already_installed: boolean;
  detent_org_id?: string;
}

export interface GitHubOrgsResponse {
  orgs: GitHubOrgWithStatus[];
}

// GitHub Organizations API methods
export const getGitHubOrgs = (
  accessToken: string,
  githubToken?: string | null
): Promise<GitHubOrgsResponse> =>
  apiRequest<GitHubOrgsResponse>("/v1/auth/github-orgs", {
    accessToken,
    // Pass GitHub OAuth token if available (avoids need for WorkOS Pipes)
    ...(githubToken && { headers: { "X-GitHub-Token": githubToken } }),
  });

// GitHub Token Refresh types
export interface GitHubTokenRefreshResponse {
  access_token: string;
  access_token_expires_at: number;
  refresh_token: string;
  refresh_token_expires_at: number;
}

// GitHub Token Refresh API method
export const refreshGitHubToken = (
  accessToken: string,
  githubRefreshToken: string
): Promise<GitHubTokenRefreshResponse> =>
  apiRequest<GitHubTokenRefreshResponse>("/v1/auth/github-token/refresh", {
    accessToken,
    method: "POST",
    body: { refresh_token: githubRefreshToken },
  });

// ============================================================================
// Errors Types
// ============================================================================

export interface RunInfo {
  id: string;
  runId: string | null;
  workflowName: string | null;
  conclusion: string | null;
  runAttempt: number | null;
  errorCount: number | null;
  headBranch: string | null;
  completedAt: string | null;
}

export interface ErrorInfo {
  id: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  message: string;
  category: string | null;
  severity: string | null;
  source: string | null;
  ruleId: string | null;
  hint: string | null;
  workflowJob: string | null;
}

export interface ErrorsResponse {
  commit: string | null;
  repository: string;
  runs: RunInfo[];
  errors: ErrorInfo[];
}

// Errors API methods
export const getErrors = (
  accessToken: string,
  commit: string,
  repository: string
): Promise<ErrorsResponse> =>
  apiRequest<ErrorsResponse>(
    `/v1/errors?commit=${encodeURIComponent(commit)}&repository=${encodeURIComponent(repository)}`,
    { accessToken }
  );
