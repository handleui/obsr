export interface AuthConfigApiKey {
  type: "apiKey";
  token: string;
}

export interface AuthConfigJwt {
  type: "jwt";
  token: string;
}

export type AuthConfig = AuthConfigApiKey | AuthConfigJwt;

export interface DetentConfig {
  baseUrl?: string;
  auth: AuthConfig;
  timeout?: number;
}


export interface Organization {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  github_org: string;
  provider_account_type: "organization" | "user";
  role: string;
  github_linked: boolean;
  github_username: string | null;
}

export interface OrganizationsResponse {
  organizations: Organization[];
}

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

export interface GitHubTokenRefreshResponse {
  access_token: string;
  access_token_expires_at: number;
  refresh_token: string;
  refresh_token_expires_at: number;
}

export interface Project {
  project_id: string;
  organization_id: string;
  organization_name?: string;
  organization_slug?: string;
  handle: string;
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

export type MemberRole = "owner" | "admin" | "member" | "visitor";

export type InvitationRole = "admin" | "member" | "visitor";

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface OrganizationMember {
  user_id: string;
  role: MemberRole;
  github_linked: boolean;
  github_user_id: string | null;
  github_username: string | null;
  joined_at: string;
}

export interface CurrentUserAccess {
  user_id: string;
  github_user_id: string;
  github_username: string;
  role: MemberRole;
  is_installer: boolean;
}

export interface OrganizationMembersResponse {
  current_user: CurrentUserAccess;
  detent_members: OrganizationMember[];
  note: string;
}

export interface LeaveOrganizationResponse {
  success: boolean;
}

export interface DeleteOrganizationResponse {
  success: boolean;
  provider_account_login: string;
  provider_account_type: "organization" | "user";
}

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

export interface CodeSnippet {
  lines: string[];
  startLine: number;
  errorLine: number;
  language: string;
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
  hints: string[] | null;
  stackTrace: string | null;
  codeSnippet: CodeSnippet | null;
  fixable: boolean;
  relatedFiles: string[] | null;
  workflowJob: string | null;
}

export interface ErrorsResponse {
  commit: string | null;
  repository: string;
  runs: RunInfo[];
  errors: ErrorInfo[];
}


export interface Invitation {
  id: string;
  email: string;
  role: InvitationRole;
  status: InvitationStatus;
  expires_at: string;
  invited_by: string | null;
  inviter_name?: string;
  created_at: string;
}

export interface InvitationsResponse {
  invitations: Invitation[];
}

export interface CreateInvitationResponse {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

export interface RevokeInvitationResponse {
  success: boolean;
}

export type HealStatus =
  | "found"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "applied";

export interface Heal {
  id: string;
  type: string;
  status: HealStatus;
  commitSha: string | null;
  prNumber: number | null;
  errorIds: string[];
  signatureIds: string[] | null;
  patch: string | null;
  commitMessage: string | null;
  filesChanged: string[] | null;
  autofixSource: string | null;
  autofixCommand: string | null;
  healResult: unknown | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  appliedAt: string | null;
  appliedCommitSha: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  failedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HealsResponse {
  heals: Heal[];
}

export interface HealDetailsResponse {
  heal: Heal & {
    runId: string | null;
    projectId: string;
  };
}

export interface TriggerHealResponse {
  success: boolean;
  message: string;
  projectId: string;
  prNumber: number;
  healsCreated: number;
  healIds: string[];
  autofixes: unknown[];
}

export interface ApplyHealResponse {
  success: boolean;
  commitSha?: string;
  commitUrl?: string;
  alreadyApplied?: boolean;
}

export interface RejectHealResponse {
  success: boolean;
  message: string;
}

export type WebhookEventType =
  | "heal.pending"
  | "heal.running"
  | "heal.completed"
  | "heal.applied"
  | "heal.rejected"
  | "heal.failed";

export interface Webhook {
  id: string;
  url: string;
  name: string;
  events: WebhookEventType[];
  secret_prefix: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateWebhookRequest {
  url: string;
  name: string;
  events: WebhookEventType[];
}

export interface CreateWebhookResponse extends Webhook {
  secret: string;
}

export interface UpdateWebhookRequest {
  url?: string;
  name?: string;
  events?: WebhookEventType[];
  active?: boolean;
}

export interface WebhooksResponse {
  webhooks: Webhook[];
}

export interface WebhookResponse {
  webhook: Webhook;
}

export interface DeleteWebhookResponse {
  success: boolean;
  deleted_id: string;
}

export interface WebhookHealData {
  heal_id: string;
  type: "autofix" | "heal";
  status: string;
  project_id: string;
  pr_number: number | null;
  commit_sha: string | null;
  patch?: string | null;
  files_changed?: string[] | null;
  applied_commit_sha?: string | null;
  failed_reason?: string | null;
  cost_usd?: number | null;
}

export interface WebhookPayload {
  id: string;
  event: WebhookEventType;
  timestamp: string;
  organization_id: string;
  data: WebhookHealData;
}
