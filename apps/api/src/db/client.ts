// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: legacy namespace dispatcher maintained for compatibility during migration
// biome-ignore-all lint/style/noNestedTernary: explicit unknown payload coercion is easier to audit in this adapter
import {
  apiKeyOps,
  commitJobStatsOps,
  type Db,
  invitationOps,
  jobOps,
  organizationMemberOps,
  organizationOps,
  prCommentOps,
  projectOps,
  resolveOps,
  webhookOps,
} from "@obsr/db";
import { getPersistentDb } from "../lib/db";
import type { Env } from "../types/env";

type QueryArgs = Record<string, unknown> | undefined;

type QueryFn = (name: string, args?: QueryArgs) => Promise<unknown>;

export interface ObserverClient {
  query: QueryFn;
  mutation: QueryFn;
}

const toTimestamp = (value: Date | null | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  return value.getTime();
};

const toIsoString = (value: number | undefined): string | null => {
  if (value === undefined) {
    return null;
  }
  return new Date(value).toISOString();
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
};

const requireNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${field} is required`);
  }
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${field} is required`);
  }
  return value;
};

const getArgs = (args?: QueryArgs): Record<string, unknown> => args ?? {};

const withDb = <T>(env: Env, fn: (db: Db) => Promise<T>) => {
  const { db } = getPersistentDb(env);
  return fn(db);
};

const toDBOrganization = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  slug: string;
  enterpriseId: string | null;
  provider: "github" | "gitlab";
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerAvatarUrl: string | null;
  providerInstallationId: string | null;
  providerAccessTokenEncrypted: string | null;
  providerAccessTokenExpiresAt: Date | null;
  providerWebhookSecret: string | null;
  installerGithubId: string | null;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  lastSyncedAt: Date | null;
  settings: Record<string, unknown> | null;
  polarCustomerId: string | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  name: row.name,
  slug: row.slug,
  enterpriseId: row.enterpriseId ?? undefined,
  provider: row.provider,
  providerAccountId: row.providerAccountId,
  providerAccountLogin: row.providerAccountLogin,
  providerAccountType: row.providerAccountType,
  providerAvatarUrl: row.providerAvatarUrl ?? undefined,
  providerInstallationId: row.providerInstallationId ?? undefined,
  providerAccessTokenEncrypted: row.providerAccessTokenEncrypted ?? undefined,
  providerAccessTokenExpiresAt: toTimestamp(row.providerAccessTokenExpiresAt),
  providerWebhookSecret: row.providerWebhookSecret ?? undefined,
  installerGithubId: row.installerGithubId ?? undefined,
  suspendedAt: toTimestamp(row.suspendedAt),
  deletedAt: toTimestamp(row.deletedAt),
  lastSyncedAt: toTimestamp(row.lastSyncedAt),
  settings: row.settings ?? undefined,
  polarCustomerId: row.polarCustomerId ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBProject = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
  handle: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  providerDefaultBranch: string | null;
  isPrivate: boolean;
  removedAt: Date | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  organizationId: row.organizationId,
  handle: row.handle,
  providerRepoId: row.providerRepoId,
  providerRepoName: row.providerRepoName,
  providerRepoFullName: row.providerRepoFullName,
  providerDefaultBranch: row.providerDefaultBranch ?? undefined,
  isPrivate: row.isPrivate,
  removedAt: toTimestamp(row.removedAt),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBOrganizationMember = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "visitor";
  providerUserId: string | null;
  providerUsername: string | null;
  providerLinkedAt: Date | null;
  providerVerifiedAt: Date | null;
  membershipSource: string | null;
  removedAt: Date | null;
  removalReason: string | null;
  removedBy: string | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  organizationId: row.organizationId,
  userId: row.userId,
  role: row.role,
  providerUserId: row.providerUserId ?? undefined,
  providerUsername: row.providerUsername ?? undefined,
  providerLinkedAt: toTimestamp(row.providerLinkedAt),
  providerVerifiedAt: toTimestamp(row.providerVerifiedAt),
  membershipSource: row.membershipSource ?? undefined,
  removedAt: toTimestamp(row.removedAt),
  removalReason: row.removalReason ?? undefined,
  removedBy: row.removedBy ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBInvitation = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
  email: string;
  role: "owner" | "admin" | "member" | "visitor";
  token: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: Date;
  invitedBy: string;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  organizationId: row.organizationId,
  email: row.email,
  role: row.role,
  token: row.token,
  status: row.status,
  expiresAt: row.expiresAt.getTime(),
  invitedBy: row.invitedBy,
  acceptedAt: toTimestamp(row.acceptedAt),
  acceptedByUserId: row.acceptedByUserId ?? undefined,
  revokedAt: toTimestamp(row.revokedAt),
  revokedBy: row.revokedBy ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBApiKey = (row: {
  id: string;
  organizationId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  organizationId: row.organizationId,
  keyHash: row.keyHash,
  keyPrefix: row.keyPrefix,
  name: row.name,
  createdAt: row.createdAt.getTime(),
  lastUsedAt: toTimestamp(row.lastUsedAt),
});

const toDBWebhook = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
  url: string;
  name: string;
  events: Array<
    | "resolve.pending"
    | "resolve.running"
    | "resolve.completed"
    | "resolve.applied"
    | "resolve.rejected"
    | "resolve.failed"
  >;
  secretEncrypted: string;
  secretPrefix: string;
  active: boolean;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  organizationId: row.organizationId,
  url: row.url,
  name: row.name,
  events: row.events,
  secretEncrypted: row.secretEncrypted,
  secretPrefix: row.secretPrefix,
  active: row.active,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBResolve = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  type: "autofix" | "resolve";
  status:
    | "found"
    | "pending"
    | "running"
    | "completed"
    | "applied"
    | "rejected"
    | "failed";
  runId: string | null;
  projectId: string;
  commitSha: string | null;
  prNumber: number | null;
  checkRunId: string | null;
  errorIds: string[] | null;
  signatureIds: string[] | null;
  patch: string | null;
  commitMessage: string | null;
  filesChanged: string[] | null;
  filesChangedWithContent: Array<{
    path: string;
    content: string | null;
  }> | null;
  autofixSource: string | null;
  autofixCommand: string | null;
  userInstructions: string | null;
  resolveResult: {
    model?: string | null;
    patchApplied?: boolean | null;
    verificationPassed?: boolean | null;
    toolCalls?: number | null;
  } | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  appliedAt: Date | null;
  appliedCommitSha: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  failedReason: string | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  type: row.type,
  status: row.status,
  runId: row.runId ?? undefined,
  projectId: row.projectId,
  commitSha: row.commitSha ?? undefined,
  prNumber: row.prNumber ?? undefined,
  checkRunId: row.checkRunId ?? undefined,
  errorIds: row.errorIds ?? undefined,
  signatureIds: row.signatureIds ?? undefined,
  patch: row.patch ?? undefined,
  commitMessage: row.commitMessage ?? undefined,
  filesChanged: row.filesChanged ?? undefined,
  filesChangedWithContent: row.filesChangedWithContent ?? undefined,
  autofixSource: row.autofixSource ?? undefined,
  autofixCommand: row.autofixCommand ?? undefined,
  userInstructions: row.userInstructions ?? undefined,
  resolveResult: row.resolveResult ?? undefined,
  costUsd: row.costUsd ?? undefined,
  inputTokens: row.inputTokens ?? undefined,
  outputTokens: row.outputTokens ?? undefined,
  appliedAt: toTimestamp(row.appliedAt),
  appliedCommitSha: row.appliedCommitSha ?? undefined,
  rejectedAt: toTimestamp(row.rejectedAt),
  rejectedBy: row.rejectedBy ?? undefined,
  rejectionReason: row.rejectionReason ?? undefined,
  failedReason: row.failedReason ?? undefined,
  updatedAt: row.updatedAt.getTime(),
});

const toDBJob = (row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  providerJobId: string;
  runId: string | null;
  repository: string;
  commitSha: string;
  prNumber: number | null;
  name: string;
  workflowName: string | null;
  status:
    | "queued"
    | "waiting"
    | "in_progress"
    | "completed"
    | "pending"
    | "requested";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "neutral"
    | "stale"
    | "startup_failure"
    | null;
  hasDetent: boolean;
  errorCount: number;
  htmlUrl: string | null;
  runnerName: string | null;
  headBranch: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  providerJobId: row.providerJobId,
  runId: row.runId ?? undefined,
  repository: row.repository,
  commitSha: row.commitSha,
  prNumber: row.prNumber ?? undefined,
  name: row.name,
  workflowName: row.workflowName ?? undefined,
  status: row.status,
  conclusion: row.conclusion ?? undefined,
  hasDetent: row.hasDetent,
  errorCount: row.errorCount,
  htmlUrl: row.htmlUrl ?? undefined,
  runnerName: row.runnerName ?? undefined,
  headBranch: row.headBranch ?? undefined,
  queuedAt: toTimestamp(row.queuedAt),
  startedAt: toTimestamp(row.startedAt),
  completedAt: toTimestamp(row.completedAt),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBCommitJobStats = (row: {
  id: string;
  repository: string;
  commitSha: string;
  prNumber: number | null;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  detentJobs: number;
  totalErrors: number;
  commentPosted: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  repository: row.repository,
  commitSha: row.commitSha,
  prNumber: row.prNumber ?? undefined,
  totalJobs: row.totalJobs,
  completedJobs: row.completedJobs,
  failedJobs: row.failedJobs,
  detentJobs: row.detentJobs,
  totalErrors: row.totalErrors,
  commentPosted: row.commentPosted,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const toDBPrComment = (row: {
  id: string;
  repository: string;
  prNumber: number;
  commentId: string;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  _id: row.id,
  _creationTime: row.createdAt.getTime(),
  repository: row.repository,
  prNumber: row.prNumber,
  commentId: row.commentId,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const runQuery = async (db: Db, name: string, args?: QueryArgs) => {
  const input = getArgs(args);

  switch (name) {
    case "api_keys:getById": {
      const id = requireString(input.id, "id");
      const row = await apiKeyOps.getById(db, id);
      return row ? toDBApiKey(row) : null;
    }
    case "api_keys:getByKeyHash": {
      const keyHash = requireString(input.keyHash, "keyHash");
      const row = await apiKeyOps.getByKeyHash(db, keyHash);
      return row ? toDBApiKey(row) : null;
    }
    case "api_keys:listByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await apiKeyOps.listByOrg(db, organizationId, limit);
      return rows.map(toDBApiKey);
    }
    case "webhooks:getById": {
      const id = requireString(input.id, "id");
      const row = await webhookOps.getById(db, id);
      return row ? toDBWebhook(row) : null;
    }
    case "webhooks:listByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await webhookOps.listByOrg(db, organizationId, limit);
      return rows.map(toDBWebhook);
    }
    case "webhooks:listActiveByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const rows = await webhookOps.listActiveByOrg(db, organizationId);
      return rows.map(toDBWebhook);
    }
    case "resolves:get": {
      const id = requireString(input.id, "id");
      const row = await resolveOps.getById(db, id);
      return row ? toDBResolve(row) : null;
    }
    case "resolves:getByPr": {
      const projectId = requireString(input.projectId, "projectId");
      const prNumber = requireNumber(input.prNumber, "prNumber");
      const rows = await resolveOps.getByPr(db, projectId, prNumber);
      return rows.map(toDBResolve);
    }
    case "resolves:getByProjectStatus": {
      const projectId = requireString(input.projectId, "projectId");
      const status = requireString(input.status, "status") as
        | "found"
        | "pending"
        | "running"
        | "completed"
        | "applied"
        | "rejected"
        | "failed";
      const rows = await resolveOps.getByProjectStatus(db, projectId, status);
      return rows.map(toDBResolve);
    }
    case "resolves:getActiveByProject": {
      const projectId = requireString(input.projectId, "projectId");
      const rows = await resolveOps.getActiveByProject(db, projectId);
      return rows.map(toDBResolve);
    }
    case "resolves:getByRunId": {
      const runId = requireString(input.runId, "runId");
      const rows = await resolveOps.getByRunId(db, runId);
      return rows.map(toDBResolve);
    }
    case "resolves:getPending": {
      const type =
        typeof input.type === "string"
          ? (input.type as "resolve" | "autofix")
          : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await resolveOps.getPending(db, type, limit);
      return rows.map(toDBResolve);
    }
    case "organizations:getById": {
      const id = requireString(input.id, "id");
      const row = await organizationOps.getById(db, id);
      return row ? toDBOrganization(row) : null;
    }
    case "organizations:getBySlug": {
      const slug = requireString(input.slug, "slug");
      const row = await organizationOps.getBySlug(db, slug);
      return row ? toDBOrganization(row) : null;
    }
    case "organizations:getByProviderAccount": {
      const provider = requireString(input.provider, "provider") as
        | "github"
        | "gitlab";
      const providerAccountId = requireString(
        input.providerAccountId,
        "providerAccountId"
      );
      const row = await organizationOps.getByProviderAccount(
        db,
        provider,
        providerAccountId
      );
      return row ? toDBOrganization(row) : null;
    }
    case "organizations:getByProviderAccountLogin": {
      const provider = requireString(input.provider, "provider") as
        | "github"
        | "gitlab";
      const providerAccountLogin = requireString(
        input.providerAccountLogin,
        "providerAccountLogin"
      );
      const row = await organizationOps.getByProviderAccountLogin(
        db,
        provider,
        providerAccountLogin
      );
      return row ? toDBOrganization(row) : null;
    }
    case "organizations:listByProviderAccountIds": {
      const provider = requireString(input.provider, "provider") as
        | "github"
        | "gitlab";
      const providerAccountIds = Array.isArray(input.providerAccountIds)
        ? input.providerAccountIds.filter(
            (id): id is string => typeof id === "string"
          )
        : [];
      const includeDeleted =
        typeof input.includeDeleted === "boolean"
          ? input.includeDeleted
          : undefined;
      const rows = await organizationOps.listByProviderAccountIds(db, {
        provider,
        providerAccountIds,
        includeDeleted,
      });
      return rows.map(toDBOrganization);
    }
    case "organizations:listByInstallerGithubId": {
      const installerGithubId = requireString(
        input.installerGithubId,
        "installerGithubId"
      );
      const rows = await organizationOps.listByInstallerGithubId(
        db,
        installerGithubId
      );
      return rows.map(toDBOrganization);
    }
    case "organizations:listByEnterprise": {
      const enterpriseId = requireString(input.enterpriseId, "enterpriseId");
      const rows = await organizationOps.listByEnterprise(db, enterpriseId);
      return rows.map(toDBOrganization);
    }
    case "organizations:listByProviderInstallationId": {
      const providerInstallationId = requireString(
        input.providerInstallationId,
        "providerInstallationId"
      );
      const rows = await organizationOps.listByProviderInstallationId(
        db,
        providerInstallationId
      );
      return rows.map(toDBOrganization);
    }
    case "organizations:list": {
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await organizationOps.list(db, limit);
      return rows.map(toDBOrganization);
    }
    case "organizations:listActiveGithub": {
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await organizationOps.listActiveGithub(db, limit);
      return rows.map(toDBOrganization);
    }
    case "organization_members:getByOrgUser": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const userId = requireString(input.userId, "userId");
      const row = await organizationMemberOps.getByOrgUser(
        db,
        organizationId,
        userId
      );
      return row ? toDBOrganizationMember(row) : null;
    }
    case "organization_members:getByOrgProviderUser": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const providerUserId = requireString(
        input.providerUserId,
        "providerUserId"
      );
      const row = await organizationMemberOps.getByOrgProviderUser(
        db,
        organizationId,
        providerUserId
      );
      return row ? toDBOrganizationMember(row) : null;
    }
    case "organization_members:listByOrgProviderUser": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const providerUserId = requireString(
        input.providerUserId,
        "providerUserId"
      );
      const rows = await organizationMemberOps.listByOrgProviderUser(
        db,
        organizationId,
        providerUserId
      );
      return rows.map(toDBOrganizationMember);
    }
    case "organization_members:listByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const includeRemoved =
        typeof input.includeRemoved === "boolean"
          ? input.includeRemoved
          : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await organizationMemberOps.listByOrg(db, {
        organizationId,
        includeRemoved,
        limit,
      });
      return rows.map(toDBOrganizationMember);
    }
    case "organization_members:paginateByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const includeRemoved =
        typeof input.includeRemoved === "boolean"
          ? input.includeRemoved
          : undefined;
      const paginationOpts =
        typeof input.paginationOpts === "object" && input.paginationOpts
          ? (input.paginationOpts as {
              cursor: string | null;
              numItems: number;
            })
          : { cursor: null, numItems: 100 };
      const result = await organizationMemberOps.paginateByOrg(db, {
        organizationId,
        includeRemoved,
        cursor: paginationOpts.cursor,
        numItems: paginationOpts.numItems,
      });
      return {
        ...result,
        page: result.page.map(toDBOrganizationMember),
      };
    }
    case "organization_members:listByUser": {
      const userId = requireString(input.userId, "userId");
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await organizationMemberOps.listByUser(db, userId, limit);
      return rows.map(toDBOrganizationMember);
    }
    case "organization_members:listByOrgRole": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const role = requireString(input.role, "role") as
        | "owner"
        | "admin"
        | "member"
        | "visitor";
      const rows = await organizationMemberOps.listByOrgRole(
        db,
        organizationId,
        role
      );
      return rows.map(toDBOrganizationMember);
    }
    case "organization_members:listByProviderUserId": {
      const providerUserId = requireString(
        input.providerUserId,
        "providerUserId"
      );
      const rows = await organizationMemberOps.listByProviderUserId(
        db,
        providerUserId
      );
      return rows.map(toDBOrganizationMember);
    }
    case "projects:getById": {
      const id = requireString(input.id, "id");
      const row = await projectOps.getById(db, id);
      return row ? toDBProject(row) : null;
    }
    case "projects:listByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const includeRemoved =
        typeof input.includeRemoved === "boolean"
          ? input.includeRemoved
          : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await projectOps.listByOrg(db, {
        organizationId,
        includeRemoved,
        limit,
      });
      return rows.map(toDBProject);
    }
    case "projects:countByOrg": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const includeRemoved =
        typeof input.includeRemoved === "boolean"
          ? input.includeRemoved
          : undefined;
      return projectOps.countByOrg(db, organizationId, includeRemoved);
    }
    case "projects:getByOrgHandle": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const handle = requireString(input.handle, "handle");
      const row = await projectOps.getByOrgHandle(db, organizationId, handle);
      return row ? toDBProject(row) : null;
    }
    case "projects:getByOrgRepo": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const providerRepoId = requireString(
        input.providerRepoId,
        "providerRepoId"
      );
      const row = await projectOps.getByOrgRepo(
        db,
        organizationId,
        providerRepoId
      );
      return row ? toDBProject(row) : null;
    }
    case "projects:getByRepoFullName": {
      const providerRepoFullName = requireString(
        input.providerRepoFullName,
        "providerRepoFullName"
      );
      const row = await projectOps.getByRepoFullName(db, providerRepoFullName);
      return row ? toDBProject(row) : null;
    }
    case "projects:getByRepoId": {
      const providerRepoId = requireString(
        input.providerRepoId,
        "providerRepoId"
      );
      const row = await projectOps.getByRepoId(db, providerRepoId);
      return row ? toDBProject(row) : null;
    }
    case "projects:listByRepoIds": {
      const providerRepoIds = Array.isArray(input.providerRepoIds)
        ? input.providerRepoIds.filter(
            (id): id is string => typeof id === "string"
          )
        : [];
      const rows = await projectOps.listByRepoIds(db, providerRepoIds);
      return rows.map(toDBProject);
    }
    case "invitations:getById": {
      const id = requireString(input.id, "id");
      const row = await invitationOps.getById(db, id);
      return row ? toDBInvitation(row) : null;
    }
    case "invitations:getByToken": {
      const token = requireString(input.token, "token");
      const row = await invitationOps.getByToken(db, token);
      return row ? toDBInvitation(row) : null;
    }
    case "invitations:listByOrgStatus": {
      const organizationId = requireString(
        input.organizationId,
        "organizationId"
      );
      const status = requireString(input.status, "status") as
        | "pending"
        | "accepted"
        | "expired"
        | "revoked";
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const rows = await invitationOps.listByOrgStatus(
        db,
        organizationId,
        status,
        limit
      );
      return rows.map(toDBInvitation);
    }
    case "jobs:paginateByRepoCommit": {
      const repository = requireString(input.repository, "repository");
      const commitSha = requireString(input.commitSha, "commitSha");
      const paginationOpts =
        typeof input.paginationOpts === "object" && input.paginationOpts
          ? (input.paginationOpts as {
              cursor: string | null;
              numItems: number;
            })
          : { cursor: null, numItems: 100 };
      const result = await jobOps.paginateByRepoCommit(db, {
        repository,
        commitSha,
        paginationOpts,
      });
      return {
        ...result,
        page: result.page.map(toDBJob),
      };
    }
    case "commit_job_stats:getByRepoCommit": {
      const repository = requireString(input.repository, "repository");
      const commitSha = requireString(input.commitSha, "commitSha");
      const row = await commitJobStatsOps.getByRepoCommit(
        db,
        repository,
        commitSha
      );
      return row ? toDBCommitJobStats(row) : null;
    }
    case "pr_comments:getByRepoPr": {
      const repository = requireString(input.repository, "repository");
      const prNumber = requireNumber(input.prNumber, "prNumber");
      const row = await prCommentOps.getByRepoPr(db, repository, prNumber);
      return row ? toDBPrComment(row) : null;
    }
    default:
      throw new Error(`Unsupported observer query: ${name}`);
  }
};

const runMutation = async (db: Db, name: string, args?: QueryArgs) => {
  const input = getArgs(args);

  switch (name) {
    case "api_keys:create": {
      return apiKeyOps.create(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        keyHash: requireString(input.keyHash, "keyHash"),
        keyPrefix: requireString(input.keyPrefix, "keyPrefix"),
        name: requireString(input.name, "name"),
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        lastUsedAt:
          typeof input.lastUsedAt === "number"
            ? input.lastUsedAt
            : input.lastUsedAt === null
              ? null
              : undefined,
      });
    }
    case "api_keys:updateLastUsedAt": {
      return apiKeyOps.updateLastUsedAt(
        db,
        requireString(input.id, "id"),
        requireNumber(input.lastUsedAt, "lastUsedAt")
      );
    }
    case "api_keys:update": {
      return apiKeyOps.update(db, {
        id: requireString(input.id, "id"),
        name: typeof input.name === "string" ? input.name : undefined,
        lastUsedAt:
          typeof input.lastUsedAt === "number"
            ? input.lastUsedAt
            : input.lastUsedAt === null
              ? null
              : undefined,
      });
    }
    case "api_keys:remove": {
      return apiKeyOps.remove(db, requireString(input.id, "id"));
    }
    case "webhooks:create": {
      return webhookOps.create(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        url: requireString(input.url, "url"),
        name: requireString(input.name, "name"),
        events: Array.isArray(input.events)
          ? (input.events as Array<
              | "resolve.pending"
              | "resolve.running"
              | "resolve.completed"
              | "resolve.applied"
              | "resolve.rejected"
              | "resolve.failed"
            >)
          : [],
        secretEncrypted: requireString(
          input.secretEncrypted,
          "secretEncrypted"
        ),
        secretPrefix: requireString(input.secretPrefix, "secretPrefix"),
        active: typeof input.active === "boolean" ? input.active : undefined,
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "webhooks:update": {
      return webhookOps.update(db, {
        id: requireString(input.id, "id"),
        url: typeof input.url === "string" ? input.url : undefined,
        name: typeof input.name === "string" ? input.name : undefined,
        events: Array.isArray(input.events)
          ? (input.events as Array<
              | "resolve.pending"
              | "resolve.running"
              | "resolve.completed"
              | "resolve.applied"
              | "resolve.rejected"
              | "resolve.failed"
            >)
          : undefined,
        active: typeof input.active === "boolean" ? input.active : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "webhooks:remove": {
      return webhookOps.remove(db, requireString(input.id, "id"));
    }
    case "resolves:create": {
      return resolveOps.create(db, {
        type: requireString(input.type, "type") as "autofix" | "resolve",
        status: (typeof input.status === "string" ? input.status : undefined) as
          | "found"
          | "pending"
          | "running"
          | "completed"
          | "applied"
          | "rejected"
          | "failed"
          | undefined,
        runId: typeof input.runId === "string" ? input.runId : null,
        projectId: requireString(input.projectId, "projectId"),
        commitSha: typeof input.commitSha === "string" ? input.commitSha : null,
        prNumber: typeof input.prNumber === "number" ? input.prNumber : null,
        checkRunId:
          typeof input.checkRunId === "string" ? input.checkRunId : null,
        errorIds: Array.isArray(input.errorIds)
          ? (input.errorIds.filter(
              (id): id is string => typeof id === "string"
            ) ?? null)
          : null,
        signatureIds: Array.isArray(input.signatureIds)
          ? (input.signatureIds.filter(
              (id): id is string => typeof id === "string"
            ) ?? null)
          : null,
        patch: typeof input.patch === "string" ? input.patch : null,
        commitMessage:
          typeof input.commitMessage === "string" ? input.commitMessage : null,
        filesChanged: Array.isArray(input.filesChanged)
          ? input.filesChanged.filter(
              (path): path is string => typeof path === "string"
            )
          : null,
        filesChangedWithContent: Array.isArray(input.filesChangedWithContent)
          ? (input.filesChangedWithContent as Array<{
              path: string;
              content: string | null;
            }>)
          : null,
        autofixSource:
          typeof input.autofixSource === "string" ? input.autofixSource : null,
        autofixCommand:
          typeof input.autofixCommand === "string"
            ? input.autofixCommand
            : null,
        userInstructions:
          typeof input.userInstructions === "string"
            ? input.userInstructions
            : null,
        resolveResult:
          typeof input.resolveResult === "object" && input.resolveResult
            ? (input.resolveResult as {
                model?: string | null;
                patchApplied?: boolean | null;
                verificationPassed?: boolean | null;
                toolCalls?: number | null;
              })
            : null,
        costUsd: typeof input.costUsd === "number" ? input.costUsd : null,
        inputTokens:
          typeof input.inputTokens === "number" ? input.inputTokens : null,
        outputTokens:
          typeof input.outputTokens === "number" ? input.outputTokens : null,
        appliedAt:
          typeof input.appliedAt === "number"
            ? new Date(input.appliedAt)
            : null,
        appliedCommitSha:
          typeof input.appliedCommitSha === "string"
            ? input.appliedCommitSha
            : null,
        rejectedAt:
          typeof input.rejectedAt === "number"
            ? new Date(input.rejectedAt)
            : null,
        rejectedBy:
          typeof input.rejectedBy === "string" ? input.rejectedBy : null,
        rejectionReason:
          typeof input.rejectionReason === "string"
            ? input.rejectionReason
            : null,
        failedReason:
          typeof input.failedReason === "string" ? input.failedReason : null,
      });
    }
    case "resolves:updateStatus": {
      return resolveOps.updateStatus(db, {
        id: requireString(input.id, "id"),
        status: requireString(input.status, "status") as
          | "found"
          | "pending"
          | "running"
          | "completed"
          | "applied"
          | "rejected"
          | "failed",
        expectedStatus:
          typeof input.expectedStatus === "string"
            ? (input.expectedStatus as
                | "found"
                | "pending"
                | "running"
                | "completed"
                | "applied"
                | "rejected"
                | "failed")
            : undefined,
        patch: typeof input.patch === "string" ? input.patch : null,
        commitMessage:
          typeof input.commitMessage === "string" ? input.commitMessage : null,
        filesChanged: Array.isArray(input.filesChanged)
          ? input.filesChanged.filter(
              (path): path is string => typeof path === "string"
            )
          : undefined,
        filesChangedWithContent: Array.isArray(input.filesChangedWithContent)
          ? (input.filesChangedWithContent as Array<{
              path: string;
              content: string | null;
            }>)
          : undefined,
        resolveResult:
          typeof input.resolveResult === "object" && input.resolveResult
            ? (input.resolveResult as {
                model?: string | null;
                patchApplied?: boolean | null;
                verificationPassed?: boolean | null;
                toolCalls?: number | null;
              })
            : undefined,
        costUsd: typeof input.costUsd === "number" ? input.costUsd : undefined,
        inputTokens:
          typeof input.inputTokens === "number" ? input.inputTokens : undefined,
        outputTokens:
          typeof input.outputTokens === "number"
            ? input.outputTokens
            : undefined,
        failedReason:
          typeof input.failedReason === "string"
            ? input.failedReason
            : undefined,
      });
    }
    case "resolves:apply": {
      return resolveOps.apply(
        db,
        requireString(input.id, "id"),
        requireString(input.appliedCommitSha, "appliedCommitSha")
      );
    }
    case "resolves:reject": {
      return resolveOps.reject(
        db,
        requireString(input.id, "id"),
        requireString(input.rejectedBy, "rejectedBy"),
        typeof input.reason === "string" ? input.reason : undefined
      );
    }
    case "resolves:trigger": {
      return resolveOps.trigger(db, requireString(input.id, "id"));
    }
    case "resolves:setCheckRunId": {
      return resolveOps.setCheckRunId(
        db,
        requireString(input.id, "id"),
        requireString(input.checkRunId, "checkRunId")
      );
    }
    case "resolves:markStaleResolvesAsFailed": {
      return resolveOps.markStaleResolvesAsFailed(db, {
        timeoutMinutes: requireNumber(input.timeoutMinutes, "timeoutMinutes"),
        resolveType: requireString(input.resolveType, "resolveType") as
          | "resolve"
          | "autofix",
        failedReason:
          typeof input.failedReason === "string" ? input.failedReason : null,
      });
    }
    case "organizations:create": {
      return organizationOps.create(db, {
        name: requireString(input.name, "name"),
        slug: requireString(input.slug, "slug"),
        enterpriseId:
          typeof input.enterpriseId === "string"
            ? input.enterpriseId
            : input.enterpriseId === null
              ? null
              : undefined,
        provider: requireString(input.provider, "provider") as
          | "github"
          | "gitlab",
        providerAccountId: requireString(
          input.providerAccountId,
          "providerAccountId"
        ),
        providerAccountLogin: requireString(
          input.providerAccountLogin,
          "providerAccountLogin"
        ),
        providerAccountType: requireString(
          input.providerAccountType,
          "providerAccountType"
        ) as "organization" | "user",
        providerAvatarUrl:
          typeof input.providerAvatarUrl === "string"
            ? input.providerAvatarUrl
            : input.providerAvatarUrl === null
              ? null
              : undefined,
        providerInstallationId:
          typeof input.providerInstallationId === "string"
            ? input.providerInstallationId
            : input.providerInstallationId === null
              ? null
              : undefined,
        providerAccessTokenEncrypted:
          typeof input.providerAccessTokenEncrypted === "string"
            ? input.providerAccessTokenEncrypted
            : input.providerAccessTokenEncrypted === null
              ? null
              : undefined,
        providerAccessTokenExpiresAt:
          typeof input.providerAccessTokenExpiresAt === "number"
            ? input.providerAccessTokenExpiresAt
            : input.providerAccessTokenExpiresAt === null
              ? null
              : undefined,
        providerWebhookSecret:
          typeof input.providerWebhookSecret === "string"
            ? input.providerWebhookSecret
            : input.providerWebhookSecret === null
              ? null
              : undefined,
        installerGithubId:
          typeof input.installerGithubId === "string"
            ? input.installerGithubId
            : input.installerGithubId === null
              ? null
              : undefined,
        suspendedAt:
          typeof input.suspendedAt === "number"
            ? input.suspendedAt
            : input.suspendedAt === null
              ? null
              : undefined,
        deletedAt:
          typeof input.deletedAt === "number"
            ? input.deletedAt
            : input.deletedAt === null
              ? null
              : undefined,
        lastSyncedAt:
          typeof input.lastSyncedAt === "number"
            ? input.lastSyncedAt
            : input.lastSyncedAt === null
              ? null
              : undefined,
        settings:
          typeof input.settings === "object" && input.settings
            ? (input.settings as Record<string, unknown>)
            : undefined,
        polarCustomerId:
          typeof input.polarCustomerId === "string"
            ? input.polarCustomerId
            : input.polarCustomerId === null
              ? null
              : undefined,
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "organizations:update": {
      return organizationOps.update(db, {
        id: requireString(input.id, "id"),
        name: typeof input.name === "string" ? input.name : undefined,
        slug: typeof input.slug === "string" ? input.slug : undefined,
        enterpriseId:
          typeof input.enterpriseId === "string"
            ? input.enterpriseId
            : input.enterpriseId === null
              ? null
              : undefined,
        provider:
          typeof input.provider === "string"
            ? (input.provider as "github" | "gitlab")
            : undefined,
        providerAccountId:
          typeof input.providerAccountId === "string"
            ? input.providerAccountId
            : undefined,
        providerAccountLogin:
          typeof input.providerAccountLogin === "string"
            ? input.providerAccountLogin
            : undefined,
        providerAccountType:
          typeof input.providerAccountType === "string"
            ? (input.providerAccountType as "organization" | "user")
            : undefined,
        providerAvatarUrl:
          typeof input.providerAvatarUrl === "string"
            ? input.providerAvatarUrl
            : input.providerAvatarUrl === null
              ? null
              : undefined,
        providerInstallationId:
          typeof input.providerInstallationId === "string"
            ? input.providerInstallationId
            : input.providerInstallationId === null
              ? null
              : undefined,
        providerAccessTokenEncrypted:
          typeof input.providerAccessTokenEncrypted === "string"
            ? input.providerAccessTokenEncrypted
            : input.providerAccessTokenEncrypted === null
              ? null
              : undefined,
        providerAccessTokenExpiresAt:
          typeof input.providerAccessTokenExpiresAt === "number"
            ? input.providerAccessTokenExpiresAt
            : input.providerAccessTokenExpiresAt === null
              ? null
              : undefined,
        providerWebhookSecret:
          typeof input.providerWebhookSecret === "string"
            ? input.providerWebhookSecret
            : input.providerWebhookSecret === null
              ? null
              : undefined,
        installerGithubId:
          typeof input.installerGithubId === "string"
            ? input.installerGithubId
            : input.installerGithubId === null
              ? null
              : undefined,
        suspendedAt:
          typeof input.suspendedAt === "number"
            ? input.suspendedAt
            : input.suspendedAt === null
              ? null
              : undefined,
        deletedAt:
          typeof input.deletedAt === "number"
            ? input.deletedAt
            : input.deletedAt === null
              ? null
              : undefined,
        lastSyncedAt:
          typeof input.lastSyncedAt === "number"
            ? input.lastSyncedAt
            : input.lastSyncedAt === null
              ? null
              : undefined,
        settings:
          typeof input.settings === "object" && input.settings
            ? (input.settings as Record<string, unknown>)
            : undefined,
        polarCustomerId:
          typeof input.polarCustomerId === "string"
            ? input.polarCustomerId
            : input.polarCustomerId === null
              ? null
              : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "organization_members:create": {
      return organizationMemberOps.create(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        userId: requireString(input.userId, "userId"),
        role: requireString(input.role, "role") as
          | "owner"
          | "admin"
          | "member"
          | "visitor",
        providerUserId:
          typeof input.providerUserId === "string"
            ? input.providerUserId
            : input.providerUserId === null
              ? null
              : undefined,
        providerUsername:
          typeof input.providerUsername === "string"
            ? input.providerUsername
            : input.providerUsername === null
              ? null
              : undefined,
        providerLinkedAt:
          typeof input.providerLinkedAt === "number"
            ? input.providerLinkedAt
            : input.providerLinkedAt === null
              ? null
              : undefined,
        providerVerifiedAt:
          typeof input.providerVerifiedAt === "number"
            ? input.providerVerifiedAt
            : input.providerVerifiedAt === null
              ? null
              : undefined,
        membershipSource:
          typeof input.membershipSource === "string"
            ? input.membershipSource
            : input.membershipSource === null
              ? null
              : undefined,
        removedAt:
          typeof input.removedAt === "number"
            ? input.removedAt
            : input.removedAt === null
              ? null
              : undefined,
        removalReason:
          typeof input.removalReason === "string"
            ? input.removalReason
            : input.removalReason === null
              ? null
              : undefined,
        removedBy:
          typeof input.removedBy === "string"
            ? input.removedBy
            : input.removedBy === null
              ? null
              : undefined,
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "organization_members:createIfMissing": {
      const row = await organizationMemberOps.createIfMissing(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        userId: requireString(input.userId, "userId"),
        role: requireString(input.role, "role") as
          | "owner"
          | "admin"
          | "member"
          | "visitor",
        providerUserId:
          typeof input.providerUserId === "string"
            ? input.providerUserId
            : input.providerUserId === null
              ? null
              : undefined,
        providerUsername:
          typeof input.providerUsername === "string"
            ? input.providerUsername
            : input.providerUsername === null
              ? null
              : undefined,
        providerLinkedAt:
          typeof input.providerLinkedAt === "number"
            ? input.providerLinkedAt
            : input.providerLinkedAt === null
              ? null
              : undefined,
        providerVerifiedAt:
          typeof input.providerVerifiedAt === "number"
            ? input.providerVerifiedAt
            : input.providerVerifiedAt === null
              ? null
              : undefined,
        membershipSource:
          typeof input.membershipSource === "string"
            ? input.membershipSource
            : input.membershipSource === null
              ? null
              : undefined,
      });
      return row ? toDBOrganizationMember(row) : null;
    }
    case "organization_members:update": {
      return organizationMemberOps.update(db, {
        id: requireString(input.id, "id"),
        role:
          typeof input.role === "string"
            ? (input.role as "owner" | "admin" | "member" | "visitor")
            : undefined,
        providerUserId:
          typeof input.providerUserId === "string"
            ? input.providerUserId
            : input.providerUserId === null
              ? null
              : undefined,
        providerUsername:
          typeof input.providerUsername === "string"
            ? input.providerUsername
            : input.providerUsername === null
              ? null
              : undefined,
        providerLinkedAt:
          typeof input.providerLinkedAt === "number"
            ? input.providerLinkedAt
            : input.providerLinkedAt === null
              ? null
              : undefined,
        providerVerifiedAt:
          typeof input.providerVerifiedAt === "number"
            ? input.providerVerifiedAt
            : input.providerVerifiedAt === null
              ? null
              : undefined,
        membershipSource:
          typeof input.membershipSource === "string"
            ? input.membershipSource
            : input.membershipSource === null
              ? null
              : undefined,
        removedAt:
          typeof input.removedAt === "number"
            ? input.removedAt
            : input.removedAt === null
              ? null
              : undefined,
        removalReason:
          typeof input.removalReason === "string"
            ? input.removalReason
            : input.removalReason === null
              ? null
              : undefined,
        removedBy:
          typeof input.removedBy === "string"
            ? input.removedBy
            : input.removedBy === null
              ? null
              : undefined,
        updatedAt:
          typeof input.updatedAt === "number"
            ? input.updatedAt
            : input.updatedAt === null
              ? null
              : undefined,
      });
    }
    case "organization_members:leaveOrganization": {
      return organizationMemberOps.leaveOrganization(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        userId: requireString(input.userId, "userId"),
        removedBy: requireString(input.removedBy, "removedBy"),
      });
    }
    case "organization_members:updateRole": {
      return organizationMemberOps.updateRole(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        targetUserId: requireString(input.targetUserId, "targetUserId"),
        actorRole: requireString(input.actorRole, "actorRole") as
          | "owner"
          | "admin"
          | "member"
          | "visitor",
        newRole: requireString(input.newRole, "newRole") as
          | "owner"
          | "admin"
          | "member"
          | "visitor",
      });
    }
    case "projects:create": {
      return projectOps.create(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        handle: requireString(input.handle, "handle"),
        providerRepoId: requireString(input.providerRepoId, "providerRepoId"),
        providerRepoName: requireString(
          input.providerRepoName,
          "providerRepoName"
        ),
        providerRepoFullName: requireString(
          input.providerRepoFullName,
          "providerRepoFullName"
        ),
        providerDefaultBranch:
          typeof input.providerDefaultBranch === "string"
            ? input.providerDefaultBranch
            : input.providerDefaultBranch === null
              ? null
              : undefined,
        isPrivate: requireBoolean(input.isPrivate, "isPrivate"),
        removedAt:
          typeof input.removedAt === "number"
            ? input.removedAt
            : input.removedAt === null
              ? null
              : undefined,
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "projects:update": {
      return projectOps.update(db, {
        id: requireString(input.id, "id"),
        organizationId:
          typeof input.organizationId === "string"
            ? input.organizationId
            : undefined,
        handle: typeof input.handle === "string" ? input.handle : undefined,
        providerRepoId:
          typeof input.providerRepoId === "string"
            ? input.providerRepoId
            : undefined,
        providerRepoName:
          typeof input.providerRepoName === "string"
            ? input.providerRepoName
            : undefined,
        providerRepoFullName:
          typeof input.providerRepoFullName === "string"
            ? input.providerRepoFullName
            : undefined,
        providerDefaultBranch:
          typeof input.providerDefaultBranch === "string"
            ? input.providerDefaultBranch
            : input.providerDefaultBranch === null
              ? null
              : undefined,
        isPrivate:
          typeof input.isPrivate === "boolean" ? input.isPrivate : undefined,
        removedAt:
          typeof input.removedAt === "number"
            ? input.removedAt
            : input.removedAt === null
              ? null
              : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "projects:reactivate": {
      return projectOps.reactivate(db, {
        id: requireString(input.id, "id"),
        providerRepoName:
          typeof input.providerRepoName === "string"
            ? input.providerRepoName
            : undefined,
        providerRepoFullName:
          typeof input.providerRepoFullName === "string"
            ? input.providerRepoFullName
            : undefined,
        providerDefaultBranch:
          typeof input.providerDefaultBranch === "string"
            ? input.providerDefaultBranch
            : input.providerDefaultBranch === null
              ? null
              : undefined,
        isPrivate:
          typeof input.isPrivate === "boolean" ? input.isPrivate : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "projects:syncFromGitHub": {
      return projectOps.syncFromGitHub(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        repos: Array.isArray(input.repos)
          ? (input.repos as Array<{
              id: string;
              name: string;
              fullName: string;
              defaultBranch?: string | null;
              isPrivate: boolean;
            }>)
          : [],
        syncRemoved:
          typeof input.syncRemoved === "boolean"
            ? input.syncRemoved
            : undefined,
      });
    }
    case "projects:clearRemovedByOrg": {
      return projectOps.clearRemovedByOrg(
        db,
        requireString(input.organizationId, "organizationId"),
        typeof input.updatedAt === "number" ? input.updatedAt : undefined
      );
    }
    case "projects:softDeleteByRepoIds": {
      return projectOps.softDeleteByRepoIds(db, {
        providerRepoIds: Array.isArray(input.providerRepoIds)
          ? input.providerRepoIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        removedAt:
          typeof input.removedAt === "number" ? input.removedAt : undefined,
      });
    }
    case "projects:softDeleteByOrgRepoIds": {
      return projectOps.softDeleteByOrgRepoIds(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        providerRepoIds: Array.isArray(input.providerRepoIds)
          ? input.providerRepoIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        removedAt:
          typeof input.removedAt === "number" ? input.removedAt : undefined,
      });
    }
    case "invitations:create": {
      return invitationOps.create(db, {
        organizationId: requireString(input.organizationId, "organizationId"),
        email: requireString(input.email, "email"),
        role: requireString(input.role, "role") as
          | "owner"
          | "admin"
          | "member"
          | "visitor",
        token: requireString(input.token, "token"),
        status: requireString(input.status, "status") as
          | "pending"
          | "accepted"
          | "expired"
          | "revoked",
        expiresAt: requireNumber(input.expiresAt, "expiresAt"),
        invitedBy: requireString(input.invitedBy, "invitedBy"),
        acceptedAt:
          typeof input.acceptedAt === "number"
            ? input.acceptedAt
            : input.acceptedAt === null
              ? null
              : undefined,
        acceptedByUserId:
          typeof input.acceptedByUserId === "string"
            ? input.acceptedByUserId
            : input.acceptedByUserId === null
              ? null
              : undefined,
        revokedAt:
          typeof input.revokedAt === "number"
            ? input.revokedAt
            : input.revokedAt === null
              ? null
              : undefined,
        revokedBy:
          typeof input.revokedBy === "string"
            ? input.revokedBy
            : input.revokedBy === null
              ? null
              : undefined,
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "invitations:update": {
      return invitationOps.update(db, {
        id: requireString(input.id, "id"),
        status:
          typeof input.status === "string"
            ? (input.status as "pending" | "accepted" | "expired" | "revoked")
            : undefined,
        expiresAt:
          typeof input.expiresAt === "number" ? input.expiresAt : undefined,
        acceptedAt:
          typeof input.acceptedAt === "number"
            ? input.acceptedAt
            : input.acceptedAt === null
              ? null
              : undefined,
        acceptedByUserId:
          typeof input.acceptedByUserId === "string"
            ? input.acceptedByUserId
            : input.acceptedByUserId === null
              ? null
              : undefined,
        revokedAt:
          typeof input.revokedAt === "number"
            ? input.revokedAt
            : input.revokedAt === null
              ? null
              : undefined,
        revokedBy:
          typeof input.revokedBy === "string"
            ? input.revokedBy
            : input.revokedBy === null
              ? null
              : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "invitations:remove": {
      return invitationOps.remove(db, requireString(input.id, "id"));
    }
    case "invitations:accept": {
      return invitationOps.accept(db, {
        token: requireString(input.token, "token"),
        userId: requireString(input.userId, "userId"),
        githubUserId: requireString(input.githubUserId, "githubUserId"),
        githubUsername: requireString(input.githubUsername, "githubUsername"),
      });
    }
    case "jobs:upsertByRepoJob": {
      return jobOps.upsertByRepoJob(db, {
        repository: requireString(input.repository, "repository"),
        providerJobId: requireString(input.providerJobId, "providerJobId"),
        data: input.data as {
          providerJobId: string;
          runId?: string;
          repository: string;
          commitSha: string;
          prNumber?: number;
          name: string;
          workflowName?: string;
          status:
            | "queued"
            | "waiting"
            | "in_progress"
            | "completed"
            | "pending"
            | "requested";
          conclusion?:
            | "success"
            | "failure"
            | "cancelled"
            | "skipped"
            | "timed_out"
            | "action_required"
            | "neutral"
            | "stale"
            | "startup_failure";
          hasDetent: boolean;
          errorCount: number;
          htmlUrl?: string;
          runnerName?: string;
          headBranch?: string;
          queuedAt?: number;
          startedAt?: number;
          completedAt?: number;
        },
      });
    }
    case "jobs:markDetentByRepoCommitName": {
      return jobOps.markDetentByRepoCommitName(
        db,
        requireString(input.repository, "repository"),
        requireString(input.commitSha, "commitSha"),
        requireString(input.name, "name"),
        requireNumber(input.errorCount, "errorCount")
      );
    }
    case "commit_job_stats:upsert": {
      return commitJobStatsOps.upsert(db, {
        repository: requireString(input.repository, "repository"),
        commitSha: requireString(input.commitSha, "commitSha"),
        prNumber:
          typeof input.prNumber === "number" ? input.prNumber : undefined,
        totalJobs: requireNumber(input.totalJobs, "totalJobs"),
        completedJobs: requireNumber(input.completedJobs, "completedJobs"),
        failedJobs: requireNumber(input.failedJobs, "failedJobs"),
        detentJobs: requireNumber(input.detentJobs, "detentJobs"),
        totalErrors: requireNumber(input.totalErrors, "totalErrors"),
        commentPosted: requireBoolean(input.commentPosted, "commentPosted"),
        createdAt:
          typeof input.createdAt === "number" ? input.createdAt : undefined,
        updatedAt:
          typeof input.updatedAt === "number" ? input.updatedAt : undefined,
      });
    }
    case "commit_job_stats:setCommentPostedByRepoCommit": {
      return commitJobStatsOps.setCommentPostedByRepoCommit(
        db,
        requireString(input.repository, "repository"),
        requireString(input.commitSha, "commitSha"),
        typeof input.commentPosted === "boolean"
          ? input.commentPosted
          : undefined
      );
    }
    case "pr_comments:upsertByRepoPr": {
      return prCommentOps.upsertByRepoPr(
        db,
        requireString(input.repository, "repository"),
        requireNumber(input.prNumber, "prNumber"),
        requireString(input.commentId, "commentId")
      );
    }
    default:
      throw new Error(`Unsupported observer mutation: ${name}`);
  }
};

export const getDbClient = (env: Env): ObserverClient => {
  return {
    query: (name, args) => withDb(env, (db) => runQuery(db, name, args)),
    mutation: (name, args) => withDb(env, (db) => runMutation(db, name, args)),
  };
};

export { toIsoString };
