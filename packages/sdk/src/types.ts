export type AuthConfig =
  | { type: "apiKey"; token: string }
  | { type: "jwt"; token: string };

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

export type InvitationRole = "admin" | "member" | "visitor";
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

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
  | "in_progress"
  | "completed"
  | "failed"
  | "rejected"
  | "applied";

export type HealType = "autofix" | "heal";

export interface Heal {
  id: string;
  type: HealType;
  status: HealStatus;
  commitSha: string | null;
  prNumber: number | null;
  errorIds: string[];
  signatureIds: string[];
  patch: string | null;
  commitMessage: string | null;
  filesChanged: string[] | null;
  autofixSource: string | null;
  autofixCommand: string | null;
  healResult: string | null;
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
  heal: Heal & { runId: string | null; projectId: string };
}

export interface TriggerHealResponse {
  success: boolean;
  status: string;
}

export interface TriggerHealByPrResponse {
  success: boolean;
  message: string;
  projectId: string;
  prNumber: number;
  healsCreated: number;
  healIds: string[];
  autofixes: number;
}

export interface ApplyHealResponse {
  success: boolean;
  message: string;
  commitSha: string;
  commitUrl: string;
}

export interface RejectHealResponse {
  success: boolean;
  message: string;
}

// ── Billing ──

export interface UsageSummary {
  orgId: string;
  period: { start: string; end: string };
  runs: { total: number; successful: number; failed: number };
}

export interface CreditUsageSummary {
  totalCostUSD: number;
  breakdown: {
    ai: { costUSD: number; percentage: number };
    sandbox: { costUSD: number; percentage: number };
  };
  eventCount: number;
  recentEvents: Array<{
    id: string;
    eventName: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
}

export interface CreateCustomerResponse {
  customerId: string;
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

export interface PortalResponse {
  portalUrl: string;
}

// ── API Keys ──

export interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeysResponse {
  api_keys: ApiKey[];
}

export interface CreateApiKeyResponse {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
  created_at: string;
}

export interface DeleteApiKeyResponse {
  success: boolean;
  deleted_id: string;
}

// ── Organization Settings ──

export interface OrganizationSettings {
  enable_inline_annotations: boolean;
  enable_pr_comments: boolean;
  heal_auto_trigger: boolean;
  validation_enabled: boolean;
}

export interface UpdateSettingsResponse {
  success: boolean;
  settings: OrganizationSettings;
}

// ── Organization Status (extended) ──

export interface OrganizationStatusDetail {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  provider: string;
  provider_account_login: string;
  provider_account_type: "organization" | "user";
  app_installed: boolean;
  suspended_at: string | null;
  project_count: number;
  created_at: string;
  last_synced_at: string | null;
  settings: OrganizationSettings;
}

// ── Projects (create/delete) ──

export interface CreateProjectRequest {
  organization_id: string;
  provider_repo_id: string;
  provider_repo_name: string;
  provider_repo_full_name: string;
  provider_default_branch?: string;
  is_private?: boolean;
  handle?: string;
}

export interface CreateProjectResponse {
  project_id: string;
  organization_id: string;
  handle: string;
  provider_repo_id: string;
  provider_repo_name: string;
  provider_repo_full_name: string;
  provider_default_branch: string | null;
  is_private: boolean;
  created: boolean;
}

export interface DeleteProjectResponse {
  success: boolean;
}
