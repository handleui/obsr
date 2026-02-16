import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { nullableBoolean, nullableNumber, nullableString } from "./validators";

const healStatus = v.union(
  v.literal("found"),
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("applied"),
  v.literal("rejected"),
  v.literal("failed")
);

const healType = v.union(v.literal("autofix"), v.literal("heal"));

const provider = v.union(v.literal("github"), v.literal("gitlab"));
const accountType = v.union(v.literal("organization"), v.literal("user"));
const organizationRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("visitor")
);
const invitationStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("expired"),
  v.literal("revoked")
);

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("waiting"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("pending"),
  v.literal("requested")
);
const jobConclusion = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("cancelled"),
  v.literal("skipped"),
  v.literal("timed_out"),
  v.literal("action_required"),
  v.literal("neutral"),
  v.literal("stale"),
  v.literal("startup_failure")
);

const organizationSettings = v.object({
  enableInlineAnnotations: v.optional(nullableBoolean),
  enablePrComments: v.optional(nullableBoolean),
  autofixEnabled: v.optional(nullableBoolean),
  autofixAutoCommit: v.optional(nullableBoolean),
  healAutoCommit: v.optional(nullableBoolean),
  healAutoTrigger: v.optional(nullableBoolean),
  healBudgetPerRunUsd: v.optional(nullableNumber),
  validationEnabled: v.optional(nullableBoolean),
});

export default defineSchema({
  enterprises: defineTable({
    name: v.string(),
    slug: v.string(),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    enterpriseId: v.optional(v.union(v.id("enterprises"), v.null())),
    provider,
    providerAccountId: v.string(),
    providerAccountLogin: v.string(),
    providerAccountType: accountType,
    providerAvatarUrl: v.optional(nullableString),
    providerInstallationId: v.optional(nullableString),
    providerAccessTokenEncrypted: v.optional(nullableString),
    providerAccessTokenExpiresAt: v.optional(nullableNumber),
    providerWebhookSecret: v.optional(nullableString),
    installerGithubId: v.optional(nullableString),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    lastSyncedAt: v.optional(nullableNumber),
    settings: organizationSettings,
    polarCustomerId: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_provider_account", ["provider", "providerAccountId"])
    .index("by_provider_account_login", ["provider", "providerAccountLogin"])
    .index("by_enterprise", ["enterpriseId"])
    .index("by_installer_github", ["installerGithubId"])
    .index("by_provider_installation", ["providerInstallationId"]),

  organizationMembers: defineTable({
    organizationId: v.id("organizations"),
    userId: v.string(),
    role: organizationRole,
    providerUserId: v.optional(nullableString),
    providerUsername: v.optional(nullableString),
    providerLinkedAt: v.optional(nullableNumber),
    providerVerifiedAt: v.optional(nullableNumber),
    membershipSource: v.optional(nullableString),
    removedAt: v.optional(nullableNumber),
    removalReason: v.optional(nullableString),
    removedBy: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_user", ["organizationId", "userId"])
    .index("by_user_id", ["userId"])
    .index("by_provider_user_id", ["providerUserId"])
    .index("by_org_role", ["organizationId", "role"])
    .index("by_removed_at", ["removedAt"])
    .index("by_org_provider_user", ["organizationId", "providerUserId"]),

  invitations: defineTable({
    organizationId: v.id("organizations"),
    email: v.string(),
    role: organizationRole,
    token: v.string(),
    status: invitationStatus,
    expiresAt: v.number(),
    invitedBy: v.string(),
    acceptedAt: v.optional(nullableNumber),
    acceptedByUserId: v.optional(nullableString),
    revokedAt: v.optional(nullableNumber),
    revokedBy: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_org_status", ["organizationId", "status"])
    .index("by_email", ["email"]),

  projects: defineTable({
    organizationId: v.id("organizations"),
    handle: v.string(),
    providerRepoId: v.string(),
    providerRepoName: v.string(),
    providerRepoFullName: v.string(),
    providerDefaultBranch: v.optional(nullableString),
    isPrivate: v.boolean(),
    removedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_handle", ["organizationId", "handle"])
    .index("by_org_repo", ["organizationId", "providerRepoId"])
    .index("by_repo_full_name", ["providerRepoFullName"])
    .index("by_repo_id", ["providerRepoId"]),

  heals: defineTable({
    type: healType,
    status: healStatus,
    runId: v.optional(nullableString),
    projectId: v.id("projects"),
    commitSha: v.optional(nullableString),
    prNumber: v.optional(nullableNumber),
    checkRunId: v.optional(nullableString),
    errorIds: v.optional(v.array(v.string())),
    signatureIds: v.optional(v.array(v.string())),
    patch: v.optional(nullableString),
    commitMessage: v.optional(nullableString),
    filesChanged: v.optional(v.array(v.string())),
    filesChangedWithContent: v.optional(
      v.array(
        v.object({
          path: v.string(),
          content: v.union(v.string(), v.null()),
        })
      )
    ),
    autofixSource: v.optional(nullableString),
    autofixCommand: v.optional(nullableString),
    userInstructions: v.optional(nullableString),
    healResult: v.optional(
      v.object({
        model: v.optional(nullableString),
        patchApplied: v.optional(nullableBoolean),
        verificationPassed: v.optional(nullableBoolean),
        toolCalls: v.optional(nullableNumber),
        commandLog: v.optional(
          v.array(
            v.object({
              tool: v.string(),
              durationMs: v.number(),
              isError: v.boolean(),
              timestamp: v.number(),
              step: v.number(),
              command: v.optional(v.string()),
              exitCode: v.optional(v.number()),
              outputBytes: v.optional(v.number()),
            })
          )
        ),
      })
    ),
    costUsd: v.optional(nullableNumber),
    inputTokens: v.optional(nullableNumber),
    outputTokens: v.optional(nullableNumber),
    appliedAt: v.optional(nullableNumber),
    appliedCommitSha: v.optional(nullableString),
    rejectedAt: v.optional(nullableNumber),
    rejectedBy: v.optional(nullableString),
    rejectionReason: v.optional(nullableString),
    failedReason: v.optional(nullableString),
    updatedAt: v.number(),
  })
    .index("by_project_status", ["projectId", "status"])
    .index("by_project_pr", ["projectId", "prNumber"])
    .index("by_status", ["status"])
    .index("by_status_type_updated_at", ["status", "type", "updatedAt"])
    .index("by_run", ["runId"]),

  jobs: defineTable({
    providerJobId: v.string(),
    runId: v.optional(nullableString),
    repository: v.string(),
    commitSha: v.string(),
    prNumber: v.optional(nullableNumber),
    name: v.string(),
    workflowName: v.optional(nullableString),
    status: jobStatus,
    conclusion: v.optional(jobConclusion),
    hasDetent: v.boolean(),
    errorCount: v.number(),
    htmlUrl: v.optional(nullableString),
    runnerName: v.optional(nullableString),
    headBranch: v.optional(nullableString),
    queuedAt: v.optional(nullableNumber),
    startedAt: v.optional(nullableNumber),
    completedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo_job", ["repository", "providerJobId"])
    .index("by_repo_commit", ["repository", "commitSha"])
    .index("by_repo_commit_name", ["repository", "commitSha", "name"])
    .index("by_run_id", ["runId"]),

  commitJobStats: defineTable({
    repository: v.string(),
    commitSha: v.string(),
    prNumber: v.optional(nullableNumber),
    totalJobs: v.number(),
    completedJobs: v.number(),
    failedJobs: v.number(),
    detentJobs: v.number(),
    totalErrors: v.number(),
    commentPosted: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_repo_commit", ["repository", "commitSha"]),

  apiKeys: defineTable({
    organizationId: v.id("organizations"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(nullableNumber),
  })
    .index("by_org", ["organizationId"])
    .index("by_key_hash", ["keyHash"]),

  prComments: defineTable({
    repository: v.string(),
    prNumber: v.number(),
    commentId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo_pr", ["repository", "prNumber"])
    .index("by_repository", ["repository"]),
});
