import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";

import type { Db } from "../client.js";
import { resolves } from "../schema/index.js";

const VALID_STATUS_TRANSITIONS: Record<string, Set<string>> = {
  found: new Set(["pending", "failed"]),
  pending: new Set(["running", "completed", "failed"]),
  running: new Set(["completed", "failed"]),
  completed: new Set(["applied", "rejected"]),
  applied: new Set(),
  rejected: new Set(),
  failed: new Set(),
};

const MAX_COMMIT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_COMMAND_LENGTH = 500;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const MAX_USER_INSTRUCTIONS_LENGTH = 2000;
const MAX_REJECTION_REASON_LENGTH = 2000;
const MAX_FAILED_REASON_LENGTH = 2000;
const MAX_PATCH_LENGTH = 1_000_000;
const MAX_REJECTED_BY_LENGTH = 255;
const MAX_FILE_PATH_LENGTH = 2048;
const MAX_DATABASE_DOC_BYTES = 900_000;
const MAX_PENDING_LIMIT = 100;
const MAX_ERROR_IDS = 500;
const MAX_FILES_CHANGED = 500;

export interface UpdateResolveStatusInput {
  id: string;
  status:
    | "found"
    | "pending"
    | "running"
    | "completed"
    | "applied"
    | "rejected"
    | "failed";
  expectedStatus?:
    | "found"
    | "pending"
    | "running"
    | "completed"
    | "applied"
    | "rejected"
    | "failed";
  patch?: string | null;
  commitMessage?: string | null;
  filesChanged?: string[];
  filesChangedWithContent?: Array<{ path: string; content: string | null }>;
  resolveResult?: {
    model?: string | null;
    patchApplied?: boolean | null;
    verificationPassed?: boolean | null;
    toolCalls?: number | null;
  };
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  failedReason?: string | null;
}

export interface MarkStaleResolvesInput {
  timeoutMinutes: number;
  resolveType: "resolve" | "autofix";
  failedReason?: string | null;
}

export interface StaleResolveEntry {
  id: string;
  projectId: string;
  checkRunId: string | null;
}

const STALE_STATUSES: Array<"pending" | "running"> = ["pending", "running"];
const STALE_MAX_PATCHES = 500;

const truncate = (
  value: string | null | undefined,
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

const getByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const sanitizeFilesChangedWithContent = (
  files: Array<{ path: string; content: string | null }> | undefined
): Array<{ path: string; content: string | null }> | undefined => {
  if (!files || files.length === 0) {
    return undefined;
  }

  return files
    .map((file) => ({
      path: truncate(file.path, MAX_FILE_PATH_LENGTH) ?? "",
      content: file.content,
    }))
    .filter((file) => file.path.length > 0);
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

const assertPayloadSize = (
  patch: string | undefined,
  files: Array<{ path: string; content: string | null }> | undefined
): void => {
  const patchBytes = patch ? getByteLength(patch) : 0;
  const filesBytes = estimateFilesChangedWithContentSize(files);
  if (patchBytes + filesBytes > MAX_DATABASE_DOC_BYTES) {
    throw new Error("Resolve payload exceeds DB document size limit");
  }
};

export const create = async (
  db: Db,
  data: Omit<
    typeof resolves.$inferInsert,
    "id" | "createdAt" | "updatedAt" | "status"
  > & {
    status?: typeof resolves.$inferInsert.status;
    patch?: string | null;
    commitMessage?: string | null;
    autofixSource?: string | null;
    autofixCommand?: string | null;
    userInstructions?: string | null;
    rejectedBy?: string | null;
    rejectionReason?: string | null;
    failedReason?: string | null;
  }
) => {
  if (data.prNumber != null && data.prNumber <= 0) {
    throw new Error("Invalid prNumber");
  }
  if (data.errorIds && data.errorIds.length > MAX_ERROR_IDS) {
    throw new Error("Too many errorIds");
  }
  if (data.signatureIds && data.signatureIds.length > MAX_ERROR_IDS) {
    throw new Error("Too many signatureIds");
  }
  if (data.filesChanged && data.filesChanged.length > MAX_FILES_CHANGED) {
    throw new Error("Too many filesChanged");
  }
  if (
    data.filesChangedWithContent &&
    data.filesChangedWithContent.length > MAX_FILES_CHANGED
  ) {
    throw new Error("Too many filesChangedWithContent");
  }

  const sanitizedPatch = truncate(data.patch, MAX_PATCH_LENGTH);
  const sanitizedFiles = sanitizeFilesChangedWithContent(
    data.filesChangedWithContent ?? undefined
  );
  assertPayloadSize(sanitizedPatch, sanitizedFiles);

  const now = new Date();
  const [row] = await db
    .insert(resolves)
    .values({
      ...data,
      status: data.status ?? "pending",
      commitSha: truncate(data.commitSha, MAX_COMMIT_LENGTH),
      checkRunId: truncate(data.checkRunId, MAX_COMMIT_LENGTH),
      patch: sanitizedPatch,
      commitMessage: truncate(data.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
      filesChangedWithContent: sanitizedFiles,
      autofixSource: truncate(data.autofixSource, MAX_SOURCE_LENGTH),
      autofixCommand: truncate(data.autofixCommand, MAX_COMMAND_LENGTH),
      userInstructions: truncate(
        data.userInstructions,
        MAX_USER_INSTRUCTIONS_LENGTH
      ),
      appliedCommitSha: truncate(data.appliedCommitSha, MAX_COMMIT_LENGTH),
      rejectedBy: truncate(data.rejectedBy, MAX_REJECTED_BY_LENGTH),
      rejectionReason: truncate(
        data.rejectionReason,
        MAX_REJECTION_REASON_LENGTH
      ),
      failedReason: truncate(data.failedReason, MAX_FAILED_REASON_LENGTH),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: resolves.id });

  return row?.id ?? null;
};

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(resolves)
    .where(eq(resolves.id, id))
    .limit(1);
  return row ?? null;
};

export const getByPr = (
  db: Db,
  projectId: string,
  prNumber: number,
  limit = 50
) =>
  db
    .select()
    .from(resolves)
    .where(
      and(eq(resolves.projectId, projectId), eq(resolves.prNumber, prNumber))
    )
    .orderBy(desc(resolves.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));

export const getByProjectStatus = (
  db: Db,
  projectId: string,
  status: typeof resolves.$inferSelect.status,
  limit = 100
) =>
  db
    .select()
    .from(resolves)
    .where(and(eq(resolves.projectId, projectId), eq(resolves.status, status)))
    .orderBy(desc(resolves.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));

export const getActiveByProject = (db: Db, projectId: string) =>
  db
    .select()
    .from(resolves)
    .where(
      and(
        eq(resolves.projectId, projectId),
        inArray(resolves.status, ["found", "pending", "running", "completed"])
      )
    )
    .orderBy(desc(resolves.createdAt))
    .limit(100);

export const getByRunId = (db: Db, runId: string, limit = 10) =>
  db
    .select()
    .from(resolves)
    .where(eq(resolves.runId, runId))
    .orderBy(desc(resolves.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));

export const getPending = (
  db: Db,
  type?: "resolve" | "autofix",
  limit?: number | null
) => {
  const take = Math.min(Math.max(limit ?? 25, 1), MAX_PENDING_LIMIT);

  if (type) {
    return db
      .select()
      .from(resolves)
      .where(and(eq(resolves.status, "pending"), eq(resolves.type, type)))
      .orderBy(asc(resolves.updatedAt))
      .limit(take);
  }

  return db
    .select()
    .from(resolves)
    .where(eq(resolves.status, "pending"))
    .orderBy(asc(resolves.updatedAt))
    .limit(take);
};

export const updateStatus = async (
  db: Db,
  input: UpdateResolveStatusInput
): Promise<string | null> => {
  const current = await getById(db, input.id);
  if (!current) {
    return null;
  }

  if (input.expectedStatus && current.status !== input.expectedStatus) {
    return null;
  }

  const allowed = VALID_STATUS_TRANSITIONS[current.status];
  if (!allowed?.has(input.status)) {
    return null;
  }

  const sanitizedPatch = truncate(input.patch, MAX_PATCH_LENGTH);
  const sanitizedFiles = sanitizeFilesChangedWithContent(
    input.filesChangedWithContent
  );
  assertPayloadSize(sanitizedPatch, sanitizedFiles);

  const [row] = await db
    .update(resolves)
    .set({
      status: input.status,
      patch: sanitizedPatch,
      commitMessage: truncate(input.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
      filesChanged: input.filesChanged,
      filesChangedWithContent: sanitizedFiles,
      resolveResult: input.resolveResult,
      costUsd: input.costUsd,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      failedReason: truncate(input.failedReason, MAX_FAILED_REASON_LENGTH),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resolves.id, input.id),
        eq(resolves.status, input.expectedStatus ?? current.status)
      )
    )
    .returning({ id: resolves.id });

  return row?.id ?? null;
};

export const apply = async (
  db: Db,
  id: string,
  appliedCommitSha: string
): Promise<string | null> => {
  const [row] = await db
    .update(resolves)
    .set({
      status: "applied",
      appliedAt: new Date(),
      appliedCommitSha:
        truncate(appliedCommitSha, MAX_COMMIT_LENGTH) ?? appliedCommitSha,
      updatedAt: new Date(),
    })
    .where(and(eq(resolves.id, id), eq(resolves.status, "completed")))
    .returning({ id: resolves.id });

  return row?.id ?? null;
};

export const reject = async (
  db: Db,
  id: string,
  rejectedBy: string,
  reason?: string | null
): Promise<string | null> => {
  const [row] = await db
    .update(resolves)
    .set({
      status: "rejected",
      rejectedAt: new Date(),
      rejectedBy: truncate(rejectedBy, MAX_REJECTED_BY_LENGTH) ?? rejectedBy,
      rejectionReason: truncate(reason, MAX_REJECTION_REASON_LENGTH),
      updatedAt: new Date(),
    })
    .where(and(eq(resolves.id, id), eq(resolves.status, "completed")))
    .returning({ id: resolves.id });

  return row?.id ?? null;
};

export const trigger = async (db: Db, id: string): Promise<boolean> => {
  const [row] = await db
    .update(resolves)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(resolves.id, id), eq(resolves.status, "found")))
    .returning({ id: resolves.id });

  return Boolean(row?.id);
};

export const setCheckRunId = async (
  db: Db,
  id: string,
  checkRunId: string
): Promise<string | null> => {
  const [row] = await db
    .update(resolves)
    .set({
      checkRunId: truncate(checkRunId, MAX_COMMIT_LENGTH) ?? checkRunId,
      updatedAt: new Date(),
    })
    .where(eq(resolves.id, id))
    .returning({ id: resolves.id });

  return row?.id ?? null;
};

export const markStaleResolvesAsFailed = async (
  db: Db,
  input: MarkStaleResolvesInput
): Promise<StaleResolveEntry[]> => {
  const stale: StaleResolveEntry[] = [];
  const now = new Date();
  const cutoff = new Date(now.getTime() - input.timeoutMinutes * 60 * 1000);
  const reason =
    truncate(input.failedReason, MAX_FAILED_REASON_LENGTH) ??
    "Resolve timed out";

  for (const status of STALE_STATUSES) {
    if (stale.length >= STALE_MAX_PATCHES) {
      break;
    }

    const budget = STALE_MAX_PATCHES - stale.length;
    const candidates = await db
      .select({
        id: resolves.id,
        projectId: resolves.projectId,
        checkRunId: resolves.checkRunId,
      })
      .from(resolves)
      .where(
        and(
          eq(resolves.status, status),
          eq(resolves.type, input.resolveType),
          lt(resolves.updatedAt, cutoff)
        )
      )
      .orderBy(asc(resolves.updatedAt))
      .limit(budget);

    for (const candidate of candidates) {
      const [updated] = await db
        .update(resolves)
        .set({
          status: "failed",
          failedReason: reason,
          updatedAt: now,
        })
        .where(and(eq(resolves.id, candidate.id), eq(resolves.status, status)))
        .returning({
          id: resolves.id,
          projectId: resolves.projectId,
          checkRunId: resolves.checkRunId,
        });

      if (updated) {
        stale.push(updated);
      }
    }
  }

  return stale;
};
