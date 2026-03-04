import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseWriter } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service_auth";
import {
  buildPatch,
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./validators";

const serviceToken = v.optional(v.string());

const healStatus = v.union(
  v.literal("found"),
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("applied"),
  v.literal("rejected"),
  v.literal("failed")
);

const resolveType = v.union(v.literal("autofix"), v.literal("resolve"));

const resolveResult = v.object({
  model: v.optional(nullableString),
  patchApplied: v.optional(nullableBoolean),
  verificationPassed: v.optional(nullableBoolean),
  toolCalls: v.optional(nullableNumber),
});

const filesChangedWithContent = v.array(
  v.object({
    path: v.string(),
    content: v.union(v.string(), v.null()),
  })
);

// HACK: pending → completed is intentional — autofix is deterministic (GitHub Action), skips running
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
const MAX_CONVEX_DOC_BYTES = 900_000;
const MAX_PENDING_LIMIT = 100;
const MAX_ERROR_IDS = 500;
const MAX_FILES_CHANGED = 500;

const getHealById = async (
  ctx: {
    db: {
      get: (id: Id<"resolves">) => Promise<Doc<"resolves"> | null>;
    };
  },
  id: Id<"resolves">
): Promise<Doc<"resolves"> | null> => {
  return await ctx.db.get(id);
};

const truncateString = (
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

const sanitizeFilesChangedWithContent = (
  files: Array<{ path: string; content: string | null }> | undefined
): Array<{ path: string; content: string | null }> | undefined => {
  if (!files || files.length === 0) {
    return undefined;
  }
  return files
    .map((file) => ({
      path: truncateString(file.path, MAX_FILE_PATH_LENGTH) ?? "",
      content: file.content,
    }))
    .filter((file) => file.path.length > 0);
};

const textEncoder = new TextEncoder();

const getByteLength = (value: string): number => {
  return textEncoder.encode(value).length;
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
  if (patchBytes + filesBytes > MAX_CONVEX_DOC_BYTES) {
    throw new Error("Resolve payload exceeds Convex document size limit");
  }
};

const validateCreateArgs = (args: {
  prNumber?: number | null;
  errorIds?: string[];
  signatureIds?: string[];
  filesChanged?: string[];
  filesChangedWithContent?: Array<{ path: string; content: string | null }>;
}) => {
  if (args.prNumber != null && args.prNumber <= 0) {
    throw new Error("Invalid prNumber");
  }
  if (args.errorIds && args.errorIds.length > MAX_ERROR_IDS) {
    throw new Error("Too many errorIds");
  }
  if (args.signatureIds && args.signatureIds.length > MAX_ERROR_IDS) {
    throw new Error("Too many signatureIds");
  }
  if (args.filesChanged && args.filesChanged.length > MAX_FILES_CHANGED) {
    throw new Error("Too many filesChanged");
  }
  if (
    args.filesChangedWithContent &&
    args.filesChangedWithContent.length > MAX_FILES_CHANGED
  ) {
    throw new Error("Too many filesChangedWithContent");
  }
};

const buildSanitizedCreatePatch = (
  args: Record<string, unknown>,
  sanitizedPatch: string | undefined,
  sanitizedFiles: Array<{ path: string; content: string | null }> | undefined
) =>
  buildPatch({
    runId: args.runId as string | undefined,
    commitSha: truncateString(args.commitSha as string, MAX_COMMIT_LENGTH),
    prNumber: args.prNumber as number | undefined,
    checkRunId: truncateString(args.checkRunId as string, MAX_COMMIT_LENGTH),
    errorIds: args.errorIds as string[] | undefined,
    signatureIds: args.signatureIds as string[] | undefined,
    patch: sanitizedPatch,
    commitMessage: truncateString(
      args.commitMessage as string,
      MAX_COMMIT_MESSAGE_LENGTH
    ),
    filesChanged: args.filesChanged as string[] | undefined,
    filesChangedWithContent: sanitizedFiles,
    autofixSource: truncateString(
      args.autofixSource as string,
      MAX_SOURCE_LENGTH
    ),
    autofixCommand: truncateString(
      args.autofixCommand as string,
      MAX_COMMAND_LENGTH
    ),
    userInstructions: truncateString(
      args.userInstructions as string,
      MAX_USER_INSTRUCTIONS_LENGTH
    ),
    resolveResult: args.resolveResult as Record<string, unknown> | undefined,
    costUsd: args.costUsd as number | undefined,
    inputTokens: args.inputTokens as number | undefined,
    outputTokens: args.outputTokens as number | undefined,
    appliedAt: args.appliedAt as number | undefined,
    appliedCommitSha: truncateString(
      args.appliedCommitSha as string,
      MAX_COMMIT_LENGTH
    ),
    rejectedAt: args.rejectedAt as number | undefined,
    rejectedBy: truncateString(
      args.rejectedBy as string,
      MAX_REJECTED_BY_LENGTH
    ),
    rejectionReason: truncateString(
      args.rejectionReason as string,
      MAX_REJECTION_REASON_LENGTH
    ),
    failedReason: truncateString(
      args.failedReason as string,
      MAX_FAILED_REASON_LENGTH
    ),
  });

export const create = mutation({
  args: {
    serviceToken,
    type: resolveType,
    status: v.optional(healStatus),
    projectId: v.id("projects"),
    runId: v.optional(v.string()),
    commitSha: v.optional(nullableString),
    prNumber: v.optional(nullableNumber),
    checkRunId: v.optional(nullableString),
    errorIds: v.optional(v.array(v.string())),
    signatureIds: v.optional(v.array(v.string())),
    patch: v.optional(nullableString),
    commitMessage: v.optional(nullableString),
    filesChanged: v.optional(v.array(v.string())),
    filesChangedWithContent: v.optional(filesChangedWithContent),
    autofixSource: v.optional(nullableString),
    autofixCommand: v.optional(nullableString),
    userInstructions: v.optional(nullableString),
    resolveResult: v.optional(resolveResult),
    costUsd: v.optional(nullableNumber),
    inputTokens: v.optional(nullableNumber),
    outputTokens: v.optional(nullableNumber),
    appliedAt: v.optional(nullableNumber),
    appliedCommitSha: v.optional(nullableString),
    rejectedAt: v.optional(nullableNumber),
    rejectedBy: v.optional(nullableString),
    rejectionReason: v.optional(nullableString),
    failedReason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    validateCreateArgs(args);

    const sanitizedPatch = truncateString(args.patch, MAX_PATCH_LENGTH);
    const sanitizedFiles = sanitizeFilesChangedWithContent(
      args.filesChangedWithContent
    );
    assertPayloadSize(sanitizedPatch, sanitizedFiles);

    const now = Date.now();
    const document = {
      type: args.type,
      status: args.status ?? "pending",
      projectId: args.projectId,
      updatedAt: now,
      ...buildSanitizedCreatePatch(args, sanitizedPatch, sanitizedFiles),
    };

    return await ctx.db.insert("resolves", document);
  },
});

export const get = query({
  args: { id: v.id("resolves"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await getHealById(ctx, args.id);
  },
});

export const getByPr = query({
  args: { projectId: v.id("projects"), prNumber: v.number(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("resolves")
      .withIndex("by_project_pr", (q) =>
        q.eq("projectId", args.projectId).eq("prNumber", args.prNumber)
      )
      .order("desc")
      .take(50);
  },
});

export const getByProjectStatus = query({
  args: { projectId: v.id("projects"), status: healStatus, serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("resolves")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", args.status)
      )
      .order("desc")
      .take(100);
  },
});

export const getActiveByProject = query({
  args: { projectId: v.id("projects"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const activeStatuses = [
      "found",
      "pending",
      "running",
      "completed",
    ] as const;
    const results = await Promise.all(
      activeStatuses.map((status) =>
        ctx.db
          .query("resolves")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", args.projectId).eq("status", status)
          )
          .order("desc")
          .take(25)
      )
    );
    return results.flat();
  },
});

export const getByRunId = query({
  args: { runId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("resolves")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(10);
  },
});

export const getPending = query({
  args: {
    type: v.optional(resolveType),
    limit: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 25, 1), MAX_PENDING_LIMIT);

    const { type } = args;
    if (type) {
      return await ctx.db
        .query("resolves")
        .withIndex("by_status_type_updated_at", (q) =>
          q.eq("status", "pending").eq("type", type)
        )
        .order("asc")
        .take(limit);
    }

    return await ctx.db
      .query("resolves")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("asc")
      .take(limit);
  },
});

const buildStatusUpdatePatch = (args: {
  status: string;
  patch?: string | null;
  commitMessage?: string | null;
  filesChanged?: string[];
  filesChangedWithContent?: Array<{ path: string; content: string | null }>;
  resolveResult?: Record<string, unknown>;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  failedReason?: string | null;
}) => {
  const sanitizedPatch = truncateString(args.patch, MAX_PATCH_LENGTH);
  const sanitizedFiles = sanitizeFilesChangedWithContent(
    args.filesChangedWithContent
  );
  assertPayloadSize(sanitizedPatch, sanitizedFiles);

  return buildPatch({
    status: args.status,
    patch: sanitizedPatch,
    commitMessage: truncateString(
      args.commitMessage,
      MAX_COMMIT_MESSAGE_LENGTH
    ),
    filesChanged: args.filesChanged,
    filesChangedWithContent: sanitizedFiles,
    resolveResult: args.resolveResult,
    costUsd: args.costUsd,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    failedReason: truncateString(args.failedReason, MAX_FAILED_REASON_LENGTH),
    updatedAt: Date.now(),
  });
};

export const updateStatus = mutation({
  args: {
    serviceToken,
    id: v.id("resolves"),
    status: healStatus,
    expectedStatus: v.optional(healStatus),
    patch: v.optional(nullableString),
    commitMessage: v.optional(nullableString),
    filesChanged: v.optional(v.array(v.string())),
    filesChangedWithContent: v.optional(filesChangedWithContent),
    resolveResult: v.optional(resolveResult),
    costUsd: v.optional(nullableNumber),
    inputTokens: v.optional(nullableNumber),
    outputTokens: v.optional(nullableNumber),
    failedReason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const resolve = await getHealById(ctx, args.id);
    if (!resolve) {
      return null;
    }
    if (args.expectedStatus && resolve.status !== args.expectedStatus) {
      return null;
    }
    const allowed = VALID_STATUS_TRANSITIONS[resolve.status];
    if (!allowed?.has(args.status)) {
      return null;
    }

    const patch = buildStatusUpdatePatch(args);
    await ctx.db.patch(resolve._id, patch);
    return String(resolve._id);
  },
});

export const apply = mutation({
  args: { id: v.id("resolves"), appliedCommitSha: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const resolve = await getHealById(ctx, args.id);
    if (!resolve) {
      return null;
    }
    if (resolve.status !== "completed") {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(resolve._id, {
      status: "applied",
      appliedAt: now,
      appliedCommitSha:
        truncateString(args.appliedCommitSha, MAX_COMMIT_LENGTH) ??
        args.appliedCommitSha,
      updatedAt: now,
    });
    return String(resolve._id);
  },
});

export const reject = mutation({
  args: {
    serviceToken,
    id: v.id("resolves"),
    rejectedBy: v.string(),
    reason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const resolve = await getHealById(ctx, args.id);
    if (!resolve) {
      return null;
    }
    if (resolve.status !== "completed") {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(resolve._id, {
      status: "rejected",
      rejectedAt: now,
      rejectedBy:
        truncateString(args.rejectedBy, MAX_REJECTED_BY_LENGTH) ??
        args.rejectedBy,
      rejectionReason: truncateString(args.reason, MAX_REJECTION_REASON_LENGTH),
      updatedAt: now,
    });
    return String(resolve._id);
  },
});

export const trigger = mutation({
  args: { id: v.id("resolves"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const resolve = await getHealById(ctx, args.id);
    if (!resolve) {
      return false;
    }
    if (resolve.status !== "found") {
      return false;
    }
    await ctx.db.patch(resolve._id, {
      status: "pending",
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setCheckRunId = mutation({
  args: { id: v.id("resolves"), checkRunId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const resolve = await getHealById(ctx, args.id);
    if (!resolve) {
      return null;
    }
    await ctx.db.patch(resolve._id, {
      checkRunId:
        truncateString(args.checkRunId, MAX_COMMIT_LENGTH) ?? args.checkRunId,
      updatedAt: Date.now(),
    });
    return String(resolve._id);
  },
});

interface DrainStaleOpts {
  status: "pending" | "running";
  resolveType: "resolve" | "autofix";
  cutoff: number;
  now: number;
  reason: string;
  batchSize: number;
  budget: number;
}

interface StaleHealEntry {
  _id: Id<"resolves">;
  projectId: Id<"projects">;
  checkRunId?: string;
}

const drainStaleHeals = async (
  db: DatabaseWriter,
  opts: DrainStaleOpts
): Promise<StaleHealEntry[]> => {
  const results: StaleHealEntry[] = [];

  while (results.length < opts.budget) {
    const take = Math.min(opts.batchSize, opts.budget - results.length);
    const candidates = await db
      .query("resolves")
      .withIndex("by_status_type_updated_at", (q) =>
        q
          .eq("status", opts.status)
          .eq("type", opts.resolveType)
          .lt("updatedAt", opts.cutoff)
      )
      .order("asc")
      .take(take);

    if (candidates.length === 0) {
      break;
    }

    for (const resolve of candidates) {
      await db.patch(resolve._id, {
        status: "failed",
        failedReason: opts.reason,
        updatedAt: opts.now,
      });
      results.push({
        _id: resolve._id,
        projectId: resolve.projectId,
        checkRunId: resolve.checkRunId ?? undefined,
      });
    }
  }

  return results;
};

const STALE_STATUSES: Array<"pending" | "running"> = ["pending", "running"];
const STALE_BATCH_SIZE = 200;
const STALE_MAX_PATCHES = 500;

export const markStaleAsFailed = mutation({
  args: {
    serviceToken,
    timeoutMinutes: v.number(),
    resolveType,
    failedReason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);

    const now = Date.now();
    const cutoff = now - args.timeoutMinutes * 60 * 1000;
    const reason =
      truncateString(args.failedReason, MAX_FAILED_REASON_LENGTH) ??
      "Resolve timed out";

    const stale: StaleHealEntry[] = [];
    for (const status of STALE_STATUSES) {
      if (stale.length >= STALE_MAX_PATCHES) {
        break;
      }
      const entries = await drainStaleHeals(ctx.db, {
        status,
        resolveType: args.resolveType,
        cutoff,
        now,
        reason,
        batchSize: STALE_BATCH_SIZE,
        budget: STALE_MAX_PATCHES - stale.length,
      });
      stale.push(...entries);
    }

    return stale.map((entry) => ({
      id: String(entry._id),
      projectId: entry.projectId,
      checkRunId: entry.checkRunId,
    }));
  },
});

const TIMEOUT_REASONS: Record<string, string> = {
  autofix: "Autofix timed out",
  resolve: "Resolve timed out",
};

const CLEANUP_HEAL_TYPES = ["resolve", "autofix"] as const;
const CLEANUP_TIMEOUT_MS = 30 * 60 * 1000;

const CLEANUP_COMBINATIONS = CLEANUP_HEAL_TYPES.flatMap((resolveType) =>
  STALE_STATUSES.map((status) => ({ resolveType, status }))
);

export const cleanupStaleHeals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - CLEANUP_TIMEOUT_MS;
    let totalCleaned = 0;

    for (const { resolveType, status } of CLEANUP_COMBINATIONS) {
      if (totalCleaned >= STALE_MAX_PATCHES) {
        break;
      }
      const entries = await drainStaleHeals(ctx.db, {
        status,
        resolveType,
        cutoff,
        now,
        reason: TIMEOUT_REASONS[resolveType],
        batchSize: STALE_BATCH_SIZE,
        budget: STALE_MAX_PATCHES - totalCleaned,
      });
      totalCleaned += entries.length;
    }

    return totalCleaned;
  },
});
