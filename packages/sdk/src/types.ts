/**
 * Detent SDK Types
 *
 * API response and request types for the Detent platform.
 */

// ============================================================================
// Configuration
// ============================================================================

export type AuthConfig =
  | { type: "apiKey"; token: string }
  | { type: "jwt"; token: string };

export interface DetentConfig {
  /** Base URL for the API (defaults to https://backend.detent.sh) */
  baseUrl?: string;
  /** Authentication configuration */
  auth: AuthConfig;
  /** Request timeout in milliseconds */
  timeout?: number;
}

// ============================================================================
// Organizations
// ============================================================================

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

// ============================================================================
// Auth / Identity
// ============================================================================

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

// ============================================================================
// Projects
// ============================================================================

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

// ============================================================================
// Organization Members
// ============================================================================

export type MemberRole = "owner" | "admin" | "member";

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

// ============================================================================
// Errors (CI Errors)
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

// ============================================================================
// Invitations
// ============================================================================

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

// ============================================================================
// Diagnostics
// ============================================================================

export type DetectedTool =
  | "eslint"
  | "vitest"
  | "typescript"
  | "cargo"
  | "golangci";

export type DiagnosticMode = "full" | "lite";

export interface DiagnosticsRequest {
  content: string;
  tool?: DetectedTool;
  mode?: DiagnosticMode;
}

export interface Diagnostic {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  hints?: string[];
  fixable?: boolean;
}

export interface DiagnosticSummary {
  errorCount: number;
  warningCount: number;
  fixableCount: number;
  fileCount: number;
}

export interface DiagnosticsResponse {
  mode: DiagnosticMode;
  detected_tool: DetectedTool | null;
  diagnostics: Diagnostic[];
  summary: DiagnosticSummary;
}

// ============================================================================
// Heals
// ============================================================================

export type HealStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "rejected"
  | "applied";

export interface Heal {
  id: string;
  project_id: string;
  pr_number: number;
  status: HealStatus;
  error_ids: string[];
  patch?: string;
  created_at: string;
  updated_at: string;
}

export interface HealsResponse {
  heals: Heal[];
}

export interface HealDetailsResponse extends Heal {
  errors: ErrorInfo[];
}

export interface TriggerHealResponse {
  heal_id: string;
  status: HealStatus;
}

export interface ApplyHealResponse {
  success: boolean;
  commit_sha?: string;
}

export interface RejectHealResponse {
  success: boolean;
}
