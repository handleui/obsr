import type {
  ResolveCreateStatus,
  ResolveStatus,
  ResolveSummary,
  ResolveType,
  ResolveUpdateStatus,
} from "@detent/types";
import { enqueueResolveForResolver } from "../../services/resolve-queue";
import type { Env } from "../../types/env";
import { getConvexClient } from "../convex";

export interface ResolveRecord {
  id: string;
  type: ResolveType;
  status: ResolveStatus;
  runId?: string;
  projectId: string;
  commitSha?: string;
  prNumber?: number;
  checkRunId?: string;
  errorIds?: string[];
  signatureIds?: string[];
  patch?: string;
  commitMessage?: string;
  filesChanged?: string[];
  filesChangedWithContent?: Array<{ path: string; content: string | null }>;
  autofixSource?: string;
  autofixCommand?: string;
  userInstructions?: string;
  resolveResult?: ResolveSummary;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  appliedAt?: Date;
  appliedCommitSha?: string;
  rejectedAt?: Date;
  rejectedBy?: string;
  rejectionReason?: string;
  failedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ConvexResolveDoc {
  _id: string;
  _creationTime: number;
  type: ResolveRecord["type"];
  status: ResolveRecord["status"];
  runId?: string;
  projectId: string;
  commitSha?: string;
  prNumber?: number;
  checkRunId?: string;
  errorIds?: string[];
  signatureIds?: string[];
  patch?: string;
  commitMessage?: string;
  filesChanged?: string[];
  filesChangedWithContent?: Array<{ path: string; content: string | null }>;
  autofixSource?: string;
  autofixCommand?: string;
  userInstructions?: string;
  resolveResult?: ResolveRecord["resolveResult"];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  appliedAt?: number;
  appliedCommitSha?: string;
  rejectedAt?: number;
  rejectedBy?: string;
  rejectionReason?: string;
  failedReason?: string;
  updatedAt: number;
}

const MAX_COMMIT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_COMMAND_LENGTH = 500;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const MAX_USER_INSTRUCTIONS_LENGTH = 2000;
const MAX_REJECTION_REASON_LENGTH = 2000;
const MAX_FAILED_REASON_LENGTH = 2000;
const MAX_PATCH_LENGTH = 1_000_000;
const MAX_REJECTED_BY_LENGTH = 255;
const MAX_RESOLVE_ID_LENGTH = 128;
const MAX_CONVEX_DOC_BYTES = 900_000;

// ============================================================================
// Validation Helpers
// ============================================================================

const truncate = (
  value: string | undefined,
  maxLength: number
): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const getByteLength = (value: string): number => {
  return new TextEncoder().encode(value).length;
};

const estimateFilesChangedWithContentSize = (
  files: Array<{ path: string; content: string | null }> | undefined
): number => {
  if (!files) {
    return 0;
  }
  let total = 0;
  for (const file of files) {
    total += getByteLength(file.path);
    if (typeof file.content === "string") {
      total += getByteLength(file.content);
    }
  }
  return total;
};

const validateResolveId = (id: string): void => {
  if (!id || typeof id !== "string") {
    throw new Error("Invalid resolveId format");
  }
  if (id.trim() !== id) {
    throw new Error("Invalid resolveId format");
  }
  if (id.length > MAX_RESOLVE_ID_LENGTH) {
    throw new Error("Invalid resolveId format: too long");
  }
};

// ============================================================================
// Convex Client
// ============================================================================

const getClient = (env: Env) => getConvexClient(env);

const toDate = (value: number | undefined): Date | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value);
};

const normalizeResolve = (resolve: ConvexResolveDoc): ResolveRecord => {
  return {
    id: resolve._id,
    type: resolve.type,
    status: resolve.status,
    runId: resolve.runId,
    projectId: resolve.projectId,
    commitSha: resolve.commitSha,
    prNumber: resolve.prNumber,
    checkRunId: resolve.checkRunId,
    errorIds: resolve.errorIds,
    signatureIds: resolve.signatureIds,
    patch: resolve.patch,
    commitMessage: resolve.commitMessage,
    filesChanged: resolve.filesChanged,
    filesChangedWithContent: resolve.filesChangedWithContent,
    autofixSource: resolve.autofixSource,
    autofixCommand: resolve.autofixCommand,
    userInstructions: resolve.userInstructions,
    resolveResult: resolve.resolveResult,
    costUsd: resolve.costUsd,
    inputTokens: resolve.inputTokens,
    outputTokens: resolve.outputTokens,
    appliedAt: toDate(resolve.appliedAt),
    appliedCommitSha: resolve.appliedCommitSha,
    rejectedAt: toDate(resolve.rejectedAt),
    rejectedBy: resolve.rejectedBy,
    rejectionReason: resolve.rejectionReason,
    failedReason: resolve.failedReason,
    createdAt: new Date(resolve._creationTime),
    updatedAt: new Date(resolve.updatedAt),
  };
};

// ============================================================================
// Operations
// ============================================================================

export const createResolve = async (
  env: Env,
  data: {
    type: ResolveType;
    projectId: string;
    status?: ResolveCreateStatus;
    runId?: string;
    commitSha?: string;
    prNumber?: number;
    errorIds?: string[];
    signatureIds?: string[];
    autofixSource?: string;
    autofixCommand?: string;
    commitMessage?: string;
    userInstructions?: string;
  }
): Promise<string> => {
  const sanitizedData = {
    type: data.type,
    status: data.status ?? "pending",
    projectId: data.projectId,
    runId: data.runId,
    commitSha: truncate(data.commitSha, MAX_COMMIT_LENGTH),
    prNumber: data.prNumber,
    errorIds: data.errorIds,
    signatureIds: data.signatureIds,
    autofixSource: truncate(data.autofixSource, MAX_SOURCE_LENGTH),
    autofixCommand: truncate(data.autofixCommand, MAX_COMMAND_LENGTH),
    commitMessage: truncate(data.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
    userInstructions: truncate(
      data.userInstructions,
      MAX_USER_INSTRUCTIONS_LENGTH
    ),
  };

  const client = getClient(env);
  const id = await client.mutation("resolves:create", sanitizedData);
  if (typeof id !== "string") {
    throw new Error("Failed to create resolve");
  }
  if (sanitizedData.type === "resolve" && sanitizedData.status === "pending") {
    await enqueueResolveForResolver(env, id, "create").catch(
      (error: unknown) => {
        console.error(
          `[resolve-queue] Failed to enqueue resolve ${id} (${sanitizedData.status}):`,
          error instanceof Error ? error.message : String(error)
        );
      }
    );
  }
  return id;
};

export const triggerResolve = async (
  env: Env,
  resolveId: string
): Promise<void> => {
  validateResolveId(resolveId);
  const client = getClient(env);
  const triggered = (await client.mutation("resolves:trigger", {
    id: resolveId,
  })) as boolean;
  if (triggered) {
    await enqueueResolveForResolver(env, resolveId, "trigger").catch(
      (error: unknown) => {
        console.error(
          `[resolve-queue] Failed to enqueue trigger resolve ${resolveId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    );
  }
};

export const updateResolveStatus = async (
  env: Env,
  resolveId: string,
  status: ResolveUpdateStatus,
  data?: {
    patch?: string;
    commitMessage?: string;
    filesChanged?: string[];
    filesChangedWithContent?: Array<{ path: string; content: string | null }>;
    resolveResult?: ResolveSummary;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    failedReason?: string;
  }
): Promise<void> => {
  validateResolveId(resolveId);

  const sanitizedResolveResult = data?.resolveResult
    ? {
        model: data.resolveResult.model,
        patchApplied: data.resolveResult.patchApplied,
        verificationPassed: data.resolveResult.verificationPassed,
        toolCalls: data.resolveResult.toolCalls,
      }
    : undefined;

  const patchBytes = data?.patch ? getByteLength(data.patch) : 0;
  const filesBytes = estimateFilesChangedWithContentSize(
    data?.filesChangedWithContent
  );
  if (patchBytes + filesBytes > MAX_CONVEX_DOC_BYTES) {
    throw new Error("Resolve payload exceeds Convex document size limit");
  }

  const sanitizedData = {
    status,
    patch: truncate(data?.patch, MAX_PATCH_LENGTH),
    commitMessage: truncate(data?.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
    filesChanged: data?.filesChanged,
    filesChangedWithContent: data?.filesChangedWithContent,
    resolveResult: sanitizedResolveResult,
    costUsd: data?.costUsd,
    inputTokens: data?.inputTokens,
    outputTokens: data?.outputTokens,
    failedReason: truncate(data?.failedReason, MAX_FAILED_REASON_LENGTH),
  };

  const client = getClient(env);
  await client.mutation("resolves:updateStatus", {
    id: resolveId,
    ...sanitizedData,
  });
};

export const applyResolve = async (
  env: Env,
  resolveId: string,
  appliedCommitSha: string
): Promise<void> => {
  validateResolveId(resolveId);
  const sanitizedCommitSha = truncate(appliedCommitSha, MAX_COMMIT_LENGTH);
  if (!sanitizedCommitSha) {
    throw new Error("Invalid appliedCommitSha");
  }
  const client = getClient(env);
  await client.mutation("resolves:apply", {
    id: resolveId,
    appliedCommitSha: sanitizedCommitSha,
  });
};

export const rejectResolve = async (
  env: Env,
  resolveId: string,
  rejectedBy: string,
  reason?: string
): Promise<void> => {
  validateResolveId(resolveId);
  const sanitizedRejectedBy = truncate(rejectedBy, MAX_REJECTED_BY_LENGTH);
  if (!sanitizedRejectedBy) {
    throw new Error("Invalid rejectedBy");
  }
  const client = getClient(env);
  await client.mutation("resolves:reject", {
    id: resolveId,
    rejectedBy: sanitizedRejectedBy,
    reason: truncate(reason, MAX_REJECTION_REASON_LENGTH),
  });
};

export const getResolvesByPr = async (
  env: Env,
  projectId: string,
  prNumber: number
): Promise<ResolveRecord[]> => {
  const client = getClient(env);
  const resolves = (await client.query("resolves:getByPr", {
    projectId,
    prNumber,
  })) as ConvexResolveDoc[];

  return resolves.map(normalizeResolve);
};

export const getResolveById = async (
  env: Env,
  resolveId: string
): Promise<ResolveRecord | null> => {
  validateResolveId(resolveId);

  const client = getClient(env);
  const resolve = (await client.query("resolves:get", {
    id: resolveId,
  })) as ConvexResolveDoc | null;

  return resolve ? normalizeResolve(resolve) : null;
};

export const getPendingResolves = (
  env: Env,
  projectId: string
): Promise<ResolveRecord[]> => {
  return getResolvesByProjectStatus(env, projectId, "pending");
};

export const getResolvesByProjectStatus = async (
  env: Env,
  projectId: string,
  status: ResolveStatus
): Promise<ResolveRecord[]> => {
  const client = getClient(env);
  const resolves = (await client.query("resolves:getByProjectStatus", {
    projectId,
    status,
  })) as ConvexResolveDoc[];

  return resolves.map(normalizeResolve);
};

export const getActiveResolvesByProject = async (
  env: Env,
  projectId: string
): Promise<ResolveRecord[]> => {
  const client = getClient(env);
  const resolves = (await client.query("resolves:getActiveByProject", {
    projectId,
  })) as ConvexResolveDoc[];

  return resolves.map(normalizeResolve);
};

export const getResolvesByRunId = async (
  env: Env,
  runId: string
): Promise<ResolveRecord[]> => {
  const client = getClient(env);
  const resolves = (await client.query("resolves:getByRunId", {
    runId,
  })) as ConvexResolveDoc[];

  return resolves.map(normalizeResolve);
};

export const resolveExistsForPrAndSource = async (
  env: Env,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<boolean> => {
  const resolves = await getResolvesByPr(env, projectId, prNumber);

  return (
    resolves.find(
      (resolve) =>
        resolve.autofixSource === autofixSource && resolve.status === "pending"
    ) !== undefined
  );
};

export const getResolveByPrAndSource = async (
  env: Env,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<ResolveRecord | null> => {
  const resolves = await getResolvesByPr(env, projectId, prNumber);
  const candidates = resolves.filter(
    (resolve) =>
      resolve.autofixSource === autofixSource &&
      (resolve.status === "pending" || resolve.status === "running")
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return candidates[0] ?? null;
};

export const markStaleResolvesAsFailed = async (
  env: Env,
  timeoutMinutes: number,
  resolveType: ResolveType
): Promise<number> => {
  if (
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < 1 ||
    timeoutMinutes > 1440
  ) {
    throw new Error(
      "Invalid timeout: must be an integer between 1 and 1440 minutes"
    );
  }

  const client = getClient(env);
  const failedReason =
    resolveType === "autofix" ? "Autofix timed out" : "Resolve timed out";

  const result = (await client.mutation("resolves:markStaleResolvesAsFailed", {
    timeoutMinutes,
    resolveType,
    failedReason,
  })) as Array<{ id: string }>;

  return result.length;
};
