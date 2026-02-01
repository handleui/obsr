import type { Env } from "../../types/env";
import { getConvexClient } from "../convex";

export interface HealRecord {
  id: string;
  type: "autofix" | "heal";
  status:
    | "found"
    | "pending"
    | "running"
    | "completed"
    | "applied"
    | "rejected"
    | "failed";
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
  healResult?: {
    model?: string;
    patchApplied?: boolean;
    verificationPassed?: boolean;
    toolCalls?: number;
  };
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

interface ConvexHealDoc {
  _id: string;
  _creationTime: number;
  type: HealRecord["type"];
  status: HealRecord["status"];
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
  healResult?: HealRecord["healResult"];
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
const MAX_HEAL_ID_LENGTH = 128;
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

const validateHealId = (id: string): void => {
  if (!id || typeof id !== "string") {
    throw new Error("Invalid healId format");
  }
  if (id.trim() !== id) {
    throw new Error("Invalid healId format");
  }
  if (id.length > MAX_HEAL_ID_LENGTH) {
    throw new Error("Invalid healId format: too long");
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

const normalizeHeal = (heal: ConvexHealDoc): HealRecord => {
  return {
    id: heal._id,
    type: heal.type,
    status: heal.status,
    runId: heal.runId,
    projectId: heal.projectId,
    commitSha: heal.commitSha,
    prNumber: heal.prNumber,
    checkRunId: heal.checkRunId,
    errorIds: heal.errorIds,
    signatureIds: heal.signatureIds,
    patch: heal.patch,
    commitMessage: heal.commitMessage,
    filesChanged: heal.filesChanged,
    filesChangedWithContent: heal.filesChangedWithContent,
    autofixSource: heal.autofixSource,
    autofixCommand: heal.autofixCommand,
    userInstructions: heal.userInstructions,
    healResult: heal.healResult,
    costUsd: heal.costUsd,
    inputTokens: heal.inputTokens,
    outputTokens: heal.outputTokens,
    appliedAt: toDate(heal.appliedAt),
    appliedCommitSha: heal.appliedCommitSha,
    rejectedAt: toDate(heal.rejectedAt),
    rejectedBy: heal.rejectedBy,
    rejectionReason: heal.rejectionReason,
    failedReason: heal.failedReason,
    createdAt: new Date(heal._creationTime),
    updatedAt: new Date(heal.updatedAt),
  };
};

// ============================================================================
// Operations
// ============================================================================

export const createHeal = async (
  env: Env,
  data: {
    type: "autofix" | "heal";
    projectId: string;
    status?: "found" | "pending";
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
  const id = await client.mutation("heals:create", sanitizedData);
  if (typeof id !== "string") {
    throw new Error("Failed to create heal");
  }
  return id;
};

export const triggerHeal = async (env: Env, healId: string): Promise<void> => {
  validateHealId(healId);
  const client = getClient(env);
  await client.mutation("heals:trigger", { id: healId });
};

export const updateHealStatus = async (
  env: Env,
  healId: string,
  status: "running" | "completed" | "applied" | "rejected" | "failed",
  data?: {
    patch?: string;
    commitMessage?: string;
    filesChanged?: string[];
    filesChangedWithContent?: Array<{ path: string; content: string | null }>;
    healResult?: object;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    failedReason?: string;
  }
): Promise<void> => {
  validateHealId(healId);

  const sanitizedHealResult =
    data?.healResult && typeof data.healResult === "object"
      ? {
          model: (data.healResult as { model?: string }).model,
          patchApplied: (data.healResult as { patchApplied?: boolean })
            .patchApplied,
          verificationPassed: (
            data.healResult as { verificationPassed?: boolean }
          ).verificationPassed,
          toolCalls: (data.healResult as { toolCalls?: number }).toolCalls,
        }
      : undefined;

  const patchBytes = data?.patch ? getByteLength(data.patch) : 0;
  const filesBytes = estimateFilesChangedWithContentSize(
    data?.filesChangedWithContent
  );
  if (patchBytes + filesBytes > MAX_CONVEX_DOC_BYTES) {
    throw new Error("Heal payload exceeds Convex document size limit");
  }

  const sanitizedData = {
    status,
    patch: truncate(data?.patch, MAX_PATCH_LENGTH),
    commitMessage: truncate(data?.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
    filesChanged: data?.filesChanged,
    filesChangedWithContent: data?.filesChangedWithContent,
    healResult: sanitizedHealResult,
    costUsd: data?.costUsd,
    inputTokens: data?.inputTokens,
    outputTokens: data?.outputTokens,
    failedReason: truncate(data?.failedReason, MAX_FAILED_REASON_LENGTH),
  };

  const client = getClient(env);
  await client.mutation("heals:updateStatus", {
    id: healId,
    ...sanitizedData,
  });
};

export const applyHeal = async (
  env: Env,
  healId: string,
  appliedCommitSha: string
): Promise<void> => {
  validateHealId(healId);
  const sanitizedCommitSha = truncate(appliedCommitSha, MAX_COMMIT_LENGTH);
  if (!sanitizedCommitSha) {
    throw new Error("Invalid appliedCommitSha");
  }
  const client = getClient(env);
  await client.mutation("heals:apply", {
    id: healId,
    appliedCommitSha: sanitizedCommitSha,
  });
};

export const rejectHeal = async (
  env: Env,
  healId: string,
  rejectedBy: string,
  reason?: string
): Promise<void> => {
  validateHealId(healId);
  const sanitizedRejectedBy = truncate(rejectedBy, MAX_REJECTED_BY_LENGTH);
  if (!sanitizedRejectedBy) {
    throw new Error("Invalid rejectedBy");
  }
  const client = getClient(env);
  await client.mutation("heals:reject", {
    id: healId,
    rejectedBy: sanitizedRejectedBy,
    reason: truncate(reason, MAX_REJECTION_REASON_LENGTH),
  });
};

export const getHealsByPr = async (
  env: Env,
  projectId: string,
  prNumber: number
): Promise<HealRecord[]> => {
  const client = getClient(env);
  const heals = (await client.query("heals:getByPr", {
    projectId,
    prNumber,
  })) as ConvexHealDoc[];

  return heals.map(normalizeHeal);
};

export const getHealById = async (
  env: Env,
  healId: string
): Promise<HealRecord | null> => {
  validateHealId(healId);

  const client = getClient(env);
  const heal = (await client.query("heals:get", {
    id: healId,
  })) as ConvexHealDoc | null;

  return heal ? normalizeHeal(heal) : null;
};

export const getPendingHeals = async (
  env: Env,
  projectId: string
): Promise<HealRecord[]> => {
  const client = getClient(env);
  const heals = (await client.query("heals:getByProjectStatus", {
    projectId,
    status: "pending",
  })) as ConvexHealDoc[];

  return heals.map(normalizeHeal);
};

export const healExistsForPrAndSource = async (
  env: Env,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<boolean> => {
  const heals = await getHealsByPr(env, projectId, prNumber);

  return (
    heals.find(
      (heal) =>
        heal.autofixSource === autofixSource && heal.status === "pending"
    ) !== undefined
  );
};

export const getHealByPrAndSource = async (
  env: Env,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<HealRecord | null> => {
  const heals = await getHealsByPr(env, projectId, prNumber);
  const candidates = heals.filter(
    (heal) =>
      heal.autofixSource === autofixSource &&
      (heal.status === "pending" || heal.status === "running")
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return candidates[0] ?? null;
};

export const markStaleHealsAsFailed = async (
  env: Env,
  timeoutMinutes: number,
  healType: "autofix" | "heal"
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
    healType === "autofix" ? "Autofix timed out" : "Heal timed out";

  const result = (await client.mutation("heals:markStaleAsFailed", {
    timeoutMinutes,
    healType,
    failedReason,
  })) as Array<{ id: string }>;

  return result.length;
};
