import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ============================================================================
// Enums
// ============================================================================

export const providerEnum = pgEnum("provider", ["github", "gitlab"]);
export const accountTypeEnum = pgEnum("account_type", ["organization", "user"]);
export const organizationRoleEnum = pgEnum("organization_role", [
  "owner",
  "admin",
  "member",
  "visitor",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

export const healTypeEnum = pgEnum("heal_type", ["autofix", "heal"]);
export const healStatusEnum = pgEnum("heal_status", [
  "pending",
  "running",
  "completed",
  "applied",
  "rejected",
  "failed",
]);

// Provider short codes for handles (used in slugs/URLs)
export const providerShortCodes: Record<"github" | "gitlab", string> = {
  github: "gh",
  gitlab: "gl",
};

// ============================================================================
// Organization Settings (JSONB for flexibility as settings grow)
// ============================================================================

export interface OrganizationSettings {
  enableInlineAnnotations?: boolean; // default: true - show inline annotations in check runs
  enablePrComments?: boolean; // default: true - post PR comments on failures
  autofixEnabled?: boolean; // default: true - run autofix scripts
  autofixAutoCommit?: boolean; // default: false - auto-push to PR
  healEnabled?: boolean; // default: false - enable AI heals
  healAutoCommit?: boolean; // default: false - auto-push AI heals
  healBudgetPerRunUsd?: number; // default: 100 (cents) - per-run limit
}

export const DEFAULT_ORG_SETTINGS: Required<OrganizationSettings> = {
  enableInlineAnnotations: true,
  enablePrComments: true,
  autofixEnabled: true,
  autofixAutoCommit: false,
  healEnabled: false,
  healAutoCommit: false,
  healBudgetPerRunUsd: 100,
};

export const getOrgSettings = (
  settings: OrganizationSettings | null | undefined
): Required<OrganizationSettings> => ({
  enableInlineAnnotations:
    settings?.enableInlineAnnotations ??
    DEFAULT_ORG_SETTINGS.enableInlineAnnotations,
  enablePrComments:
    settings?.enablePrComments ?? DEFAULT_ORG_SETTINGS.enablePrComments,
  autofixEnabled:
    settings?.autofixEnabled ?? DEFAULT_ORG_SETTINGS.autofixEnabled,
  autofixAutoCommit:
    settings?.autofixAutoCommit ?? DEFAULT_ORG_SETTINGS.autofixAutoCommit,
  healEnabled: settings?.healEnabled ?? DEFAULT_ORG_SETTINGS.healEnabled,
  healAutoCommit:
    settings?.healAutoCommit ?? DEFAULT_ORG_SETTINGS.healAutoCommit,
  healBudgetPerRunUsd:
    settings?.healBudgetPerRunUsd ?? DEFAULT_ORG_SETTINGS.healBudgetPerRunUsd,
});

// Helper to create provider-prefixed slug
export const createProviderSlug = (
  provider: "github" | "gitlab",
  login: string
): string => `${providerShortCodes[provider]}/${login.toLowerCase()}`;

// ============================================================================
// Enterprises (Groups multiple organizations - stub for future use)
// ============================================================================

export const enterprises = pgTable(
  "enterprises",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),

    // Status
    suspendedAt: timestamp("suspended_at"),
    deletedAt: timestamp("deleted_at"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("enterprises_slug_idx").on(table.slug)]
);

// ============================================================================
// Organizations (Detent organization ↔ CI Provider Account)
// ============================================================================

export const organizations = pgTable(
  "organizations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),

    // Enterprise grouping (optional, for future use)
    enterpriseId: varchar("enterprise_id", { length: 36 }).references(
      () => enterprises.id,
      { onDelete: "set null" }
    ),

    // CI Provider connection (GitHub org/user, GitLab group/user)
    provider: providerEnum("provider").notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 255,
    }).notNull(),
    providerAccountLogin: varchar("provider_account_login", {
      length: 255,
    }).notNull(),
    providerAccountType: accountTypeEnum("provider_account_type").notNull(),
    providerAvatarUrl: varchar("provider_avatar_url", { length: 500 }),

    // GitHub-specific: App installation ID (null for GitLab)
    providerInstallationId: varchar("provider_installation_id", {
      length: 255,
    }),

    // GitLab-specific: Encrypted group access token
    providerAccessTokenEncrypted: varchar("provider_access_token_encrypted", {
      length: 500,
    }),
    providerAccessTokenExpiresAt: timestamp("provider_access_token_expires_at"),

    // GitLab-specific: Webhook secret for manual webhook setup
    providerWebhookSecret: varchar("provider_webhook_secret", { length: 255 }),

    // Installer tracking - GitHub ID of user who installed the app (immutable)
    // Used to grant "owner" role to the installer when they first access the org
    installerGithubId: varchar("installer_github_id", { length: 255 }),

    // Status
    suspendedAt: timestamp("suspended_at"),
    deletedAt: timestamp("deleted_at"),

    // Sync tracking - when we last verified state with the provider
    lastSyncedAt: timestamp("last_synced_at"),

    // Settings (JSONB for flexibility as settings grow)
    settings: jsonb("settings")
      .$type<OrganizationSettings>()
      .default({})
      .notNull(),

    // Polar billing
    polarCustomerId: varchar("polar_customer_id", { length: 255 }),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("organizations_slug_idx").on(table.slug),
    // GitHub installations: unique when present (null for GitLab orgs)
    // HACK: Drizzle doesn't support partial indexes; actual WHERE NOT NULL
    // constraint is in migration 0003_gitlab_and_enterprise_support.sql
    uniqueIndex("organizations_provider_installation_id_idx").on(
      table.providerInstallationId
    ),
    // Composite unique: same provider account can't be registered twice
    uniqueIndex("organizations_provider_account_unique_idx").on(
      table.provider,
      table.providerAccountId
    ),
    // Enterprise lookup
    index("organizations_enterprise_id_idx").on(table.enterpriseId),
    // Installer lookup (for granting owner role on first access)
    index("organizations_installer_github_id_idx").on(table.installerGithubId),
  ]
);

// ============================================================================
// Organization Members (WorkOS user ↔ Organization membership)
// ============================================================================

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 36 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(), // WorkOS user_xxx ID
    role: organizationRoleEnum("role").default("member").notNull(),

    // Provider account linking (GitHub/GitLab via WorkOS OAuth)
    // Provider is inherited from the organization's provider field
    providerUserId: varchar("provider_user_id", { length: 255 }),
    providerUsername: varchar("provider_username", { length: 255 }),
    providerLinkedAt: timestamp("provider_linked_at"),

    // When membership was last verified with provider (GitHub org membership check)
    providerVerifiedAt: timestamp("provider_verified_at"),

    // How this membership was created (for UX display + sync logic)
    // Values: "github_sync" | "github_webhook" | "github_access" | "manual_invite" | "installer"
    // null for existing records (treat as "github_access")
    membershipSource: varchar("membership_source", { length: 32 }),

    // Soft-delete replaces hard-delete
    removedAt: timestamp("removed_at"),

    // Why removed (determines if auto-rejoin is allowed)
    // Values: "admin_action" (manual, blocks rejoin) | "github_left" (mirror, allows rejoin)
    removalReason: varchar("removal_reason", { length: 32 }),

    // Who removed (audit trail) - WorkOS user ID or "system"
    removedBy: varchar("removed_by", { length: 255 }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Partial unique index: only active (non-deleted) members must be unique per org+user
    // This allows soft-deleted records to exist alongside active ones, enabling rejoin
    uniqueIndex("organization_members_org_user_active_idx")
      .on(table.organizationId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
    index("organization_members_user_id_idx").on(table.userId),
    index("organization_members_provider_user_id_idx").on(table.providerUserId),
    // Composite index for role-based queries (owner count checks, elevated role counts)
    // Enables efficient COUNT(*) WHERE org_id = ? AND role IN ('owner', 'admin')
    index("organization_members_org_role_idx").on(
      table.organizationId,
      table.role
    ),
    // Index for soft-delete filtering (active members only)
    index("organization_members_removed_at_idx").on(table.removedAt),
    // Composite index for webhook/sync lookups by org + GitHub user ID
    // Covers: member add/remove webhooks, membership checks, rejoin logic
    index("organization_members_org_provider_user_idx").on(
      table.organizationId,
      table.providerUserId
    ),
  ]
);

// ============================================================================
// Invitations (Email-based organization invitations)
// ============================================================================

export const invitations = pgTable(
  "invitations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 36 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: organizationRoleEnum("role").default("member").notNull(),
    token: varchar("token", { length: 64 }).notNull().unique(),
    status: invitationStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    invitedBy: varchar("invited_by", { length: 255 }).notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedByUserId: varchar("accepted_by_user_id", { length: 255 }),
    revokedAt: timestamp("revoked_at"),
    revokedBy: varchar("revoked_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("invitations_token_idx").on(table.token),
    index("invitations_org_status_idx").on(table.organizationId, table.status),
    index("invitations_email_idx").on(table.email),
  ]
);

// ============================================================================
// Projects (Detent project ↔ CI Provider Repo)
// ============================================================================

export const projects = pgTable(
  "projects",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 36 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Handle for URL-friendly identification (e.g., "api" in @gh/handleui/api)
    // Defaults to providerRepoName, unique within organization
    handle: varchar("handle", { length: 255 }).notNull(),

    // CI Provider repo info (GitHub repo, GitLab project)
    providerRepoId: varchar("provider_repo_id", { length: 255 }).notNull(),
    providerRepoName: varchar("provider_repo_name", { length: 255 }).notNull(),
    providerRepoFullName: varchar("provider_repo_full_name", {
      length: 500,
    }).notNull(),
    providerDefaultBranch: varchar("provider_default_branch", { length: 255 }),
    isPrivate: boolean("is_private").default(false).notNull(),

    // Status
    removedAt: timestamp("removed_at"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("projects_organization_id_idx").on(table.organizationId),
    // Handle must be unique within organization
    uniqueIndex("projects_org_handle_idx").on(
      table.organizationId,
      table.handle
    ),
    uniqueIndex("projects_org_repo_idx").on(
      table.organizationId,
      table.providerRepoId
    ),
    index("projects_provider_repo_full_name_idx").on(
      table.providerRepoFullName
    ),
    // Index for webhook lookups by provider repo ID (e.g., repository.renamed events)
    index("projects_provider_repo_id_idx").on(table.providerRepoId),
  ]
);

// ============================================================================
// Runs (Workflow run tracking and log ingestion metadata)
// ============================================================================
// Stores ALL workflow runs we observe (not just failures) to build a complete
// picture of CI activity. This enables:
// - Run ID → commit/PR/branch mapping (intelligence GitHub makes hard to get)
// - Workflow reliability analytics
// - Processing audit trail ("why wasn't this commit processed?")

export const runs = pgTable(
  "runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("project_id", { length: 36 }).references(
      () => projects.id,
      { onDelete: "set null" }
    ),
    provider: providerEnum("provider"),
    source: varchar("source", { length: 32 }),
    format: varchar("format", { length: 32 }),
    // IMPORTANT: runId, repository, and runAttempt form the unique constraint.
    // Code in webhooks.ts always provides non-NULL values for these fields.
    // Schema allows NULL for backwards compatibility with existing data.
    runId: varchar("run_id", { length: 255 }),
    repository: varchar("repository", { length: 500 }),
    commitSha: varchar("commit_sha", { length: 64 }),
    prNumber: integer("pr_number"),
    checkRunId: varchar("check_run_id", { length: 64 }),
    logBytes: integer("log_bytes"),
    errorCount: integer("error_count"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),

    // Workflow identity (maps run ID back to workflow)
    workflowName: varchar("workflow_name", { length: 255 }),

    // Execution result (success, failure, cancelled, skipped, neutral, timed_out, etc.)
    conclusion: varchar("conclusion", { length: 32 }),

    // Branch context (enables branch-based analytics)
    headBranch: varchar("head_branch", { length: 255 }),

    // Re-run tracking (GitHub increments this on re-runs, starts at 1)
    runAttempt: integer("run_attempt").default(1),

    // Timing for analytics (when GitHub started/completed the run)
    runStartedAt: timestamp("run_started_at"),
    runCompletedAt: timestamp("run_completed_at"),
  },
  (table) => [
    index("runs_project_id_idx").on(table.projectId),
    index("runs_provider_run_id_idx").on(table.provider, table.runId),
    index("runs_commit_sha_idx").on(table.commitSha),
    index("runs_repository_commit_idx").on(table.repository, table.commitSha),
    index("runs_pr_number_idx").on(table.prNumber),
    // Primary deduplication: unique per repository + run ID + attempt
    // GitHub re-runs have same runId but increment runAttempt (starts at 1)
    // NOTE: This index also serves lookups by (repository, runId) since those
    // columns are the leading prefix - no separate index needed for that pattern
    uniqueIndex("runs_repository_run_attempt_unique_idx").on(
      table.repository,
      table.runId,
      table.runAttempt
    ),
    // Workflow analytics: query by workflow name (for reliability dashboards)
    index("runs_workflow_name_idx").on(table.workflowName),
    // NOTE: Removed runs_conclusion_idx - low cardinality (6-7 values) makes it
    // ineffective. Queries filtering by conclusion should use a composite index
    // or full table scan, which is often faster for low-selectivity predicates.
  ]
);

// ============================================================================
// Run Errors (Structured errors tied to runs)
// ============================================================================

export const runErrors = pgTable(
  "run_errors",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 })
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    filePath: varchar("file_path", { length: 2048 }),
    line: integer("line"),
    column: integer("column"),
    message: text("message").notNull(),
    category: varchar("category", { length: 32 }),
    severity: varchar("severity", { length: 16 }),
    ruleId: varchar("rule_id", { length: 255 }),
    source: varchar("source", { length: 64 }),
    stackTrace: text("stack_trace"),
    suggestions: jsonb("suggestions").$type<string[]>(),
    hint: text("hint"),
    workflowJob: varchar("workflow_job", { length: 255 }),
    workflowStep: varchar("workflow_step", { length: 255 }),
    workflowAction: varchar("workflow_action", { length: 255 }),
    unknownPattern: boolean("unknown_pattern"),
    lineKnown: boolean("line_known"),
    columnKnown: boolean("column_known"),
    messageTruncated: boolean("message_truncated"),
    stackTraceTruncated: boolean("stack_trace_truncated"),
    codeSnippet: jsonb("code_snippet").$type<{
      lines: string[];
      startLine: number;
      errorLine: number;
      language: string;
    }>(),
    exitCode: integer("exit_code"),
    isInfrastructure: boolean("is_infrastructure"),
    possiblyTestOutput: boolean("possibly_test_output"),
    fixable: boolean("fixable"),
    signatureId: varchar("signature_id", { length: 36 }).references(
      () => errorSignatures.id
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("run_errors_run_id_idx").on(table.runId),
    index("run_errors_category_idx").on(table.category),
    index("run_errors_source_idx").on(table.source),
    index("run_errors_rule_id_idx").on(table.ruleId),
    index("run_errors_signature_idx").on(table.signatureId),
  ]
);

// ============================================================================
// Error Signatures (Deduplicated error fingerprints)
// ============================================================================

export const errorSignatures = pgTable(
  "error_signatures",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    fingerprint: varchar("fingerprint", { length: 32 }).notNull().unique(),

    // Classification
    source: varchar("source", { length: 64 }),
    ruleId: varchar("rule_id", { length: 255 }),
    category: varchar("category", { length: 32 }),

    // Pattern (for debugging/display)
    normalizedPattern: text("normalized_pattern"),
    exampleMessage: text("example_message"),

    // Lore-readiness (future AI validation)
    loreCandidate: boolean("lore_candidate").default(true),
    loreSyncedAt: timestamp("lore_synced_at"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // NOTE: fingerprint column has unique() constraint which creates an index.
    // No additional index needed for fingerprint lookups.
    index("error_signatures_source_rule_idx").on(table.source, table.ruleId),
  ]
);

// ============================================================================
// Error Occurrences (Per-project error tracking)
// ============================================================================

export const errorOccurrences = pgTable(
  "error_occurrences",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    signatureId: varchar("signature_id", { length: 36 })
      .notNull()
      .references(() => errorSignatures.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    // Counters
    occurrenceCount: integer("occurrence_count").default(1).notNull(),
    runCount: integer("run_count").default(1).notNull(),

    // Lifecycle
    firstSeenCommit: varchar("first_seen_commit", { length: 40 }),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenCommit: varchar("last_seen_commit", { length: 40 }),
    lastSeenAt: timestamp("last_seen_at").notNull(),

    // Fix tracking (for lore)
    fixedAt: timestamp("fixed_at"),
    fixedByCommit: varchar("fixed_by_commit", { length: 40 }),
    fixVerified: boolean("fix_verified").default(false),

    // Context
    commonFiles: jsonb("common_files").$type<string[]>(),
  },
  (table) => [
    index("error_occurrences_project_idx").on(table.projectId),
    // NOTE: signatureId index is covered by the composite unique index below.
    // PostgreSQL uses leading columns of composite indexes for single-column queries.
    index("error_occurrences_last_seen_idx").on(table.lastSeenAt),
    // Primary lookup and upsert conflict target
    uniqueIndex("error_occurrences_sig_proj_idx").on(
      table.signatureId,
      table.projectId
    ),
  ]
);

// ============================================================================
// Usage Events (Local event log for Polar billing resilience)
// ============================================================================

export const usageEvents = pgTable(
  "usage_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 36 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventName: varchar("event_name", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    polarIngested: boolean("polar_ingested").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("usage_events_org_id_idx").on(table.organizationId),
    // Composite index for retry queries: WHERE polar_ingested = false ORDER BY created_at
    index("usage_events_polar_ingested_created_at_idx").on(
      table.polarIngested,
      table.createdAt
    ),
  ]
);

// ============================================================================
// PR Comments (Tracking GitHub comment IDs for deduplication)
// ============================================================================
// Persistent storage for PR comment IDs to prevent duplicate comments.
// KV serves as a fast cache; this table is the ultimate source of truth.

export const prComments = pgTable(
  "pr_comments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    repository: varchar("repository", { length: 500 }).notNull(),
    prNumber: integer("pr_number").notNull(),
    commentId: varchar("comment_id", { length: 64 }).notNull(), // GitHub comment ID
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Unique constraint: one Detent comment per PR
    uniqueIndex("pr_comments_repo_pr_unique_idx").on(
      table.repository,
      table.prNumber
    ),
    index("pr_comments_repository_idx").on(table.repository),
  ]
);

// ============================================================================
// Heals (Autofix and AI heal operations)
// ============================================================================

export const heals = pgTable(
  "heals",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    type: healTypeEnum("type").notNull(),
    status: healStatusEnum("status").default("pending").notNull(),

    // Context
    runId: varchar("run_id", { length: 36 }).references(() => runs.id, {
      onDelete: "set null",
    }),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commitSha: varchar("commit_sha", { length: 64 }),
    prNumber: integer("pr_number"),

    // Error references (JSONB arrays of IDs)
    errorIds: jsonb("error_ids").$type<string[]>(),
    signatureIds: jsonb("signature_ids").$type<string[]>(),

    // Patch data
    patch: text("patch"),
    commitMessage: varchar("commit_message", { length: 500 }),
    filesChanged: jsonb("files_changed").$type<string[]>(),
    // Full file content for pushing (path + content, null content = deleted)
    filesChangedWithContent: jsonb("files_changed_with_content").$type<
      Array<{ path: string; content: string | null }>
    >(),

    // Autofix specific
    autofixSource: varchar("autofix_source", { length: 64 }), // e.g., "biome", "eslint"
    autofixCommand: varchar("autofix_command", { length: 500 }),

    // AI heal specific
    healResult: jsonb("heal_result").$type<{
      model?: string;
      patchApplied?: boolean;
      verificationPassed?: boolean;
      toolCalls?: number;
    }>(),
    costUsd: integer("cost_usd"), // Store as cents to avoid floating point
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    // Lifecycle
    appliedAt: timestamp("applied_at"),
    appliedCommitSha: varchar("applied_commit_sha", { length: 64 }),
    rejectedAt: timestamp("rejected_at"),
    rejectedBy: varchar("rejected_by", { length: 255 }),
    rejectionReason: text("rejection_reason"),
    failedReason: text("failed_reason"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("heals_run_id_idx").on(table.runId),
    index("heals_project_id_idx").on(table.projectId),
    index("heals_pr_number_idx").on(table.prNumber),
    index("heals_status_idx").on(table.status),
    index("heals_project_status_idx").on(table.projectId, table.status),
  ]
);

// ============================================================================
// API Keys (Organization-scoped API tokens for external integrations)
// ============================================================================

export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 36 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull().unique(), // "dtk_" + 32 char random
    name: varchar("name", { length: 255 }).notNull(), // e.g. "GitHub Actions"
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [index("api_keys_org_idx").on(table.organizationId)]
);

// ============================================================================
// Relations (for Drizzle relational query API)
// ============================================================================

export const enterprisesRelations = relations(enterprises, ({ many }) => ({
  organizations: many(organizations),
}));

export const organizationsRelations = relations(
  organizations,
  ({ one, many }) => ({
    enterprise: one(enterprises, {
      fields: [organizations.enterpriseId],
      references: [enterprises.id],
    }),
    members: many(organizationMembers),
    invitations: many(invitations),
    projects: many(projects),
    usageEvents: many(usageEvents),
    apiKeys: many(apiKeys),
  })
);

export const organizationMembersRelations = relations(
  organizationMembers,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMembers.organizationId],
      references: [organizations.id],
    }),
  })
);

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  heals: many(heals),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, {
    fields: [runs.projectId],
    references: [projects.id],
  }),
  errors: many(runErrors),
  heals: many(heals),
}));

export const runErrorsRelations = relations(runErrors, ({ one }) => ({
  run: one(runs, {
    fields: [runErrors.runId],
    references: [runs.id],
  }),
  signature: one(errorSignatures, {
    fields: [runErrors.signatureId],
    references: [errorSignatures.id],
  }),
}));

export const errorSignaturesRelations = relations(
  errorSignatures,
  ({ many }) => ({
    occurrences: many(errorOccurrences),
    errors: many(runErrors),
  })
);

export const errorOccurrencesRelations = relations(
  errorOccurrences,
  ({ one }) => ({
    signature: one(errorSignatures, {
      fields: [errorOccurrences.signatureId],
      references: [errorSignatures.id],
    }),
    project: one(projects, {
      fields: [errorOccurrences.projectId],
      references: [projects.id],
    }),
  })
);

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [usageEvents.organizationId],
    references: [organizations.id],
  }),
}));

export const healsRelations = relations(heals, ({ one }) => ({
  run: one(runs, {
    fields: [heals.runId],
    references: [runs.id],
  }),
  project: one(projects, {
    fields: [heals.projectId],
    references: [projects.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
}));

// ============================================================================
// Type Exports
// ============================================================================

export type Enterprise = typeof enterprises.$inferSelect;
export type NewEnterprise = typeof enterprises.$inferInsert;

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export type RunError = typeof runErrors.$inferSelect;
export type NewRunError = typeof runErrors.$inferInsert;

export type ErrorSignature = typeof errorSignatures.$inferSelect;
export type NewErrorSignature = typeof errorSignatures.$inferInsert;

export type ErrorOccurrence = typeof errorOccurrences.$inferSelect;
export type NewErrorOccurrence = typeof errorOccurrences.$inferInsert;

export type PrComment = typeof prComments.$inferSelect;
export type NewPrComment = typeof prComments.$inferInsert;

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

export type Heal = typeof heals.$inferSelect;
export type NewHeal = typeof heals.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
