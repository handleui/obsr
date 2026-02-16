import {
  type CreateInvitationResponse,
  createClient,
  type DeleteOrganizationResponse,
  DetentAuthError,
  type DetentClient,
  DetentNetworkError,
  type ErrorsResponse,
  type GitHubOrgsResponse,
  type GitHubTokenRefreshResponse,
  type InvitationRole,
  type InvitationsResponse,
  type LeaveOrganizationResponse,
  type ListProjectsResponse,
  type MeResponse,
  type OrganizationMembersResponse,
  type OrganizationsResponse,
  type ProjectDetailsResponse,
  type RevokeInvitationResponse,
  type SyncIdentityResponse,
} from "@detent/sdk";

const API_BASE_URL = process.env.DETENT_API_URL ?? "https://backend.detent.sh";

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  accessToken: string;
  headers?: Record<string, string>;
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

const wrapApiError = (error: unknown): Error => {
  if (error instanceof DetentAuthError) {
    return new ApiAuthError(
      "Authentication failed. Your session may have expired. Run `dt auth login` to re-authenticate."
    );
  }

  if (error instanceof DetentNetworkError) {
    return new ApiNetworkError(error.message);
  }

  return error instanceof Error ? error : new Error(String(error));
};

const getClient = (accessToken: string): DetentClient =>
  createClient({
    baseUrl: API_BASE_URL,
    auth: { type: "jwt", token: accessToken },
  });

const withClient = async <T>(
  accessToken: string,
  run: (client: DetentClient) => Promise<T>
): Promise<T> => {
  try {
    return await run(getClient(accessToken));
  } catch (error) {
    throw wrapApiError(error);
  }
};

export const apiRequest = <T>(
  path: string,
  options: ApiOptions
): Promise<T> => {
  const { method = "GET", body, accessToken, headers } = options;

  return withClient(accessToken, (client) =>
    client.request<T>(path, {
      method,
      body,
      headers,
    })
  );
};

export const getOrganizations = (
  accessToken: string
): Promise<OrganizationsResponse> =>
  withClient(accessToken, (client) => client.auth.getOrganizations());

export const syncUser = (
  accessToken: string,
  githubToken?: string | null
): Promise<SyncIdentityResponse> => {
  if (process.env.DEBUG) {
    console.log(
      `[sync-user] Sending request with GitHub token: ${githubToken ? "yes" : "no"}`
    );
  }

  return withClient(accessToken, (client) =>
    client.auth.syncUser(githubToken ?? undefined)
  );
};

export const getMe = (accessToken: string): Promise<MeResponse> =>
  withClient(accessToken, (client) => client.auth.me());

export const listProjects = (
  accessToken: string,
  organizationId: string
): Promise<ListProjectsResponse> =>
  withClient(accessToken, (client) => client.projects.list(organizationId));

export const getProject = (
  accessToken: string,
  projectId: string
): Promise<ProjectDetailsResponse> =>
  withClient(accessToken, (client) => client.projects.get(projectId));

export const lookupProject = (
  accessToken: string,
  repoFullName: string
): Promise<ProjectDetailsResponse> =>
  withClient(accessToken, (client) => client.projects.lookup(repoFullName));

export const listOrganizationMembers = (
  accessToken: string,
  organizationId: string
): Promise<OrganizationMembersResponse> =>
  withClient(accessToken, (client) => client.members.list(organizationId));

export const leaveOrganization = (
  accessToken: string,
  organizationId: string
): Promise<LeaveOrganizationResponse> =>
  withClient(accessToken, (client) => client.members.leave(organizationId));

export const deleteOrganization = (
  accessToken: string,
  organizationId: string
): Promise<DeleteOrganizationResponse> =>
  withClient(accessToken, (client) =>
    client.organizations.delete(organizationId)
  );

export const getGitHubOrgs = (
  accessToken: string,
  githubToken?: string | null
): Promise<GitHubOrgsResponse> =>
  withClient(accessToken, (client) =>
    client.auth.getGitHubOrgs(githubToken ?? undefined)
  );

export const refreshGitHubToken = (
  accessToken: string,
  githubRefreshToken: string
): Promise<GitHubTokenRefreshResponse> =>
  withClient(accessToken, (client) =>
    client.auth.refreshGitHubToken(githubRefreshToken)
  );

export const getErrors = (
  accessToken: string,
  commit: string,
  repository: string
): Promise<ErrorsResponse> =>
  withClient(accessToken, (client) => client.errors.get(commit, repository));

export const createInvitation = (
  accessToken: string,
  organizationId: string,
  email: string,
  role: InvitationRole
): Promise<CreateInvitationResponse> =>
  withClient(accessToken, (client) =>
    client.invitations.create(organizationId, email, role)
  );

export const listInvitations = (
  accessToken: string,
  organizationId: string
): Promise<InvitationsResponse> =>
  withClient(accessToken, (client) => client.invitations.list(organizationId));

export const revokeInvitation = (
  accessToken: string,
  organizationId: string,
  invitationId: string
): Promise<RevokeInvitationResponse> =>
  withClient(accessToken, (client) =>
    client.invitations.revoke(organizationId, invitationId)
  );

export type {
  CreateInvitationResponse,
  CurrentUserAccess,
  DeleteOrganizationResponse,
  ErrorInfo,
  ErrorsResponse,
  GitHubOrgsResponse,
  GitHubOrgWithStatus,
  GitHubTokenRefreshResponse,
  Invitation,
  InvitationRole,
  InvitationsResponse,
  LeaveOrganizationResponse,
  ListProjectsResponse,
  MeResponse,
  Organization,
  OrganizationMember,
  OrganizationMembersResponse,
  OrganizationsResponse,
  Project,
  ProjectDetailsResponse,
  RevokeInvitationResponse,
  RunInfo,
  SyncIdentityResponse,
} from "@detent/sdk";
