import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export interface FilesChangedWithContent {
  path: string;
  content: string | null;
}

export interface ResolveResult {
  model?: string | null;
  patchApplied?: boolean | null;
  verificationPassed?: boolean | null;
  toolCalls?: number | null;
}

export const organizations = pgTable(
  "organizations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    enterpriseId: text("enterprise_id"),
    provider: text("provider", { enum: ["github", "gitlab"] }).notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    providerAccountLogin: text("provider_account_login").notNull(),
    providerAccountType: text("provider_account_type", {
      enum: ["organization", "user"],
    }).notNull(),
    providerAvatarUrl: text("provider_avatar_url"),
    providerInstallationId: text("provider_installation_id"),
    providerAccessTokenEncrypted: text("provider_access_token_encrypted"),
    providerAccessTokenExpiresAt: timestamp(
      "provider_access_token_expires_at",
      {
        withTimezone: true,
        mode: "date",
      }
    ),
    providerWebhookSecret: text("provider_webhook_secret"),
    installerGithubId: text("installer_github_id"),
    suspendedAt: timestamp("suspended_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
    settings: jsonb("settings").$type<{
      enableInlineAnnotations?: boolean | null;
      enablePrComments?: boolean | null;
      autofixEnabled?: boolean | null;
      autofixAutoCommit?: boolean | null;
      resolveAutoCommit?: boolean | null;
      resolveAutoTrigger?: boolean | null;
      resolveBudgetPerRunUsd?: number | null;
      validationEnabled?: boolean | null;
    }>(),
    polarCustomerId: text("polar_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("organizations_slug_idx").on(table.slug),
    index("organizations_provider_account_idx").on(
      table.provider,
      table.providerAccountId
    ),
    index("organizations_provider_account_login_idx").on(
      table.provider,
      table.providerAccountLogin
    ),
    index("organizations_provider_installation_idx").on(
      table.providerInstallationId
    ),
    index("organizations_installer_github_idx").on(table.installerGithubId),
    index("organizations_enterprise_idx").on(table.enterpriseId),
  ]
);

export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    providerRepoId: text("provider_repo_id").notNull(),
    providerRepoName: text("provider_repo_name").notNull(),
    providerRepoFullName: text("provider_repo_full_name").notNull(),
    providerDefaultBranch: text("provider_default_branch"),
    isPrivate: boolean("is_private").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("projects_org_idx").on(table.organizationId),
    index("projects_org_handle_idx").on(table.organizationId, table.handle),
    index("projects_org_repo_idx").on(
      table.organizationId,
      table.providerRepoId
    ),
    index("projects_repo_full_name_idx").on(table.providerRepoFullName),
    index("projects_repo_id_idx").on(table.providerRepoId),
  ]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "visitor"] })
      .notNull()
      .default("member"),
    providerUserId: text("provider_user_id"),
    providerUsername: text("provider_username"),
    providerLinkedAt: timestamp("provider_linked_at", {
      withTimezone: true,
      mode: "date",
    }),
    providerVerifiedAt: timestamp("provider_verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    membershipSource: text("membership_source"),
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
    removalReason: text("removal_reason"),
    removedBy: text("removed_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("organization_members_org_user_idx").on(
      table.organizationId,
      table.userId
    ),
    index("organization_members_user_id_idx").on(table.userId),
    index("organization_members_provider_user_id_idx").on(table.providerUserId),
    index("organization_members_org_role_idx").on(
      table.organizationId,
      table.role
    ),
    index("organization_members_removed_at_idx").on(table.removedAt),
    index("organization_members_org_provider_user_idx").on(
      table.organizationId,
      table.providerUserId
    ),
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "visitor"] })
      .notNull()
      .default("member"),
    token: text("token").notNull(),
    status: text("status", {
      enum: ["pending", "accepted", "expired", "revoked"],
    })
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    invitedBy: text("invited_by").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    acceptedByUserId: text("accepted_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revokedBy: text("revoked_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("invitations_token_uidx").on(table.token),
    index("invitations_org_status_idx").on(table.organizationId, table.status),
    index("invitations_email_idx").on(table.email),
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_uidx").on(table.keyHash),
    index("api_keys_org_idx").on(table.organizationId),
  ]
);

export const resolves = pgTable(
  "resolves",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    type: text("type", { enum: ["autofix", "resolve"] }).notNull(),
    status: text("status", {
      enum: [
        "found",
        "pending",
        "running",
        "completed",
        "applied",
        "rejected",
        "failed",
      ],
    }).notNull(),
    runId: text("run_id"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha"),
    prNumber: integer("pr_number"),
    checkRunId: text("check_run_id"),
    errorIds: text("error_ids").array(),
    signatureIds: text("signature_ids").array(),
    patch: text("patch"),
    commitMessage: text("commit_message"),
    filesChanged: text("files_changed").array(),
    filesChangedWithContent: jsonb("files_changed_with_content").$type<
      FilesChangedWithContent[]
    >(),
    autofixSource: text("autofix_source"),
    autofixCommand: text("autofix_command"),
    userInstructions: text("user_instructions"),
    resolveResult: jsonb("resolve_result").$type<ResolveResult>(),
    costUsd: integer("cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    appliedAt: timestamp("applied_at", {
      withTimezone: true,
      mode: "date",
    }),
    appliedCommitSha: text("applied_commit_sha"),
    rejectedAt: timestamp("rejected_at", {
      withTimezone: true,
      mode: "date",
    }),
    rejectedBy: text("rejected_by"),
    rejectionReason: text("rejection_reason"),
    failedReason: text("failed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("resolves_project_status_idx").on(table.projectId, table.status),
    index("resolves_project_pr_idx").on(table.projectId, table.prNumber),
    index("resolves_status_idx").on(table.status),
    index("resolves_status_type_updated_at_idx").on(
      table.status,
      table.type,
      table.updatedAt
    ),
    index("resolves_run_idx").on(table.runId),
  ]
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    providerJobId: text("provider_job_id").notNull(),
    runId: text("run_id"),
    repository: text("repository").notNull(),
    commitSha: text("commit_sha").notNull(),
    prNumber: integer("pr_number"),
    name: text("name").notNull(),
    workflowName: text("workflow_name"),
    status: text("status", {
      enum: [
        "queued",
        "waiting",
        "in_progress",
        "completed",
        "pending",
        "requested",
      ],
    }).notNull(),
    conclusion: text("conclusion", {
      enum: [
        "success",
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "neutral",
        "stale",
        "startup_failure",
      ],
    }),
    hasDetent: boolean("has_detent").notNull().default(false),
    errorCount: integer("error_count").notNull().default(0),
    htmlUrl: text("html_url"),
    runnerName: text("runner_name"),
    headBranch: text("head_branch"),
    queuedAt: timestamp("queued_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("jobs_repo_job_idx").on(table.repository, table.providerJobId),
    index("jobs_repo_commit_idx").on(table.repository, table.commitSha),
    index("jobs_repo_commit_name_idx").on(
      table.repository,
      table.commitSha,
      table.name
    ),
    index("jobs_run_id_idx").on(table.runId),
  ]
);

export const commitJobStats = pgTable(
  "commit_job_stats",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    repository: text("repository").notNull(),
    commitSha: text("commit_sha").notNull(),
    prNumber: integer("pr_number"),
    totalJobs: integer("total_jobs").notNull().default(0),
    completedJobs: integer("completed_jobs").notNull().default(0),
    failedJobs: integer("failed_jobs").notNull().default(0),
    detentJobs: integer("detent_jobs").notNull().default(0),
    totalErrors: integer("total_errors").notNull().default(0),
    commentPosted: boolean("comment_posted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("commit_job_stats_repo_commit_idx").on(
      table.repository,
      table.commitSha
    ),
    index("commit_job_stats_repo_idx").on(table.repository),
  ]
);

export const prComments = pgTable(
  "pr_comments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    commentId: text("comment_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("pr_comments_repo_pr_idx").on(table.repository, table.prNumber),
    index("pr_comments_repo_idx").on(table.repository),
  ]
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    name: text("name").notNull(),
    events: text("events", {
      enum: [
        "resolve.pending",
        "resolve.running",
        "resolve.completed",
        "resolve.applied",
        "resolve.rejected",
        "resolve.failed",
      ],
    })
      .array()
      .notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("webhooks_org_idx").on(table.organizationId),
    index("webhooks_org_active_idx").on(table.organizationId, table.active),
  ]
);
