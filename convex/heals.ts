import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
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

const healResult = v.object({
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

const buildPatch = (
  fields: Record<string, unknown>
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  return patch;
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

const getHealById = async (
  ctx: {
    db: {
      get: (id: Id<"heals">) => Promise<Doc<"heals"> | null>;
    };
  },
  id: Id<"heals">
): Promise<Doc<"heals"> | null> => {
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

const assertPayloadSize = (
  patch: string | undefined,
  files: Array<{ path: string; content: string | null }> | undefined
): void => {
  const patchBytes = patch ? getByteLength(patch) : 0;
  const filesBytes = estimateFilesChangedWithContentSize(files);
  if (patchBytes + filesBytes > MAX_CONVEX_DOC_BYTES) {
    throw new Error("Heal payload exceeds Convex document size limit");
  }
};

export const create = mutation({
  args: {
    type: healType,
    status: v.optional(healStatus),
    projectId: v.id("projects"),
    runId: v.optional(v.id("runs")),
    commitSha: v.optional(nullableString),
    prNumber: v.optional(nullableNumber),
    checkRunId: v.optional(nullableString),
    errorIds: v.optional(v.array(v.id("runErrors"))),
    signatureIds: v.optional(v.array(v.id("errorSignatures"))),
    patch: v.optional(nullableString),
    commitMessage: v.optional(nullableString),
    filesChanged: v.optional(v.array(v.string())),
    filesChangedWithContent: v.optional(filesChangedWithContent),
    autofixSource: v.optional(nullableString),
    autofixCommand: v.optional(nullableString),
    userInstructions: v.optional(nullableString),
    healResult: v.optional(healResult),
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
    if (args.prNumber != null && args.prNumber <= 0) {
      throw new Error("Invalid prNumber");
    }

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
      ...buildPatch({
        runId: args.runId,
        commitSha: truncateString(args.commitSha, MAX_COMMIT_LENGTH),
        prNumber: args.prNumber,
        checkRunId: truncateString(args.checkRunId, MAX_COMMIT_LENGTH),
        errorIds: args.errorIds,
        signatureIds: args.signatureIds,
        patch: sanitizedPatch,
        commitMessage: truncateString(
          args.commitMessage,
          MAX_COMMIT_MESSAGE_LENGTH
        ),
        filesChanged: args.filesChanged,
        filesChangedWithContent: sanitizedFiles,
        autofixSource: truncateString(args.autofixSource, MAX_SOURCE_LENGTH),
        autofixCommand: truncateString(args.autofixCommand, MAX_COMMAND_LENGTH),
        userInstructions: truncateString(
          args.userInstructions,
          MAX_USER_INSTRUCTIONS_LENGTH
        ),
        healResult: args.healResult,
        costUsd: args.costUsd,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        appliedAt: args.appliedAt,
        appliedCommitSha: truncateString(
          args.appliedCommitSha,
          MAX_COMMIT_LENGTH
        ),
        rejectedAt: args.rejectedAt,
        rejectedBy: truncateString(args.rejectedBy, MAX_REJECTED_BY_LENGTH),
        rejectionReason: truncateString(
          args.rejectionReason,
          MAX_REJECTION_REASON_LENGTH
        ),
        failedReason: truncateString(
          args.failedReason,
          MAX_FAILED_REASON_LENGTH
        ),
      }),
    };

    return await ctx.db.insert("heals", document);
  },
});

export const get = query({
  args: { id: v.id("heals") },
  handler: async (ctx, args) => {
    return await getHealById(ctx, args.id);
  },
});

export const getByPr = query({
  args: { projectId: v.id("projects"), prNumber: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("heals")
      .withIndex("by_project_pr", (q) =>
        q.eq("projectId", args.projectId).eq("prNumber", args.prNumber)
      )
      .order("desc")
      .collect();
  },
});

export const getByProjectStatus = query({
  args: { projectId: v.id("projects"), status: healStatus },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("heals")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", args.status)
      )
      .order("desc")
      .collect();
  },
});

export const getActiveByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    // Fetch active heals (non-terminal states) using the existing index
    // Active statuses: found, pending, running, completed
    // Terminal statuses: applied, rejected, failed
    const activeStatuses = [
      "found",
      "pending",
      "running",
      "completed",
    ] as const;
    const results = await Promise.all(
      activeStatuses.map((status) =>
        ctx.db
          .query("heals")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", args.projectId).eq("status", status)
          )
          .order("desc")
          .collect()
      )
    );
    return results.flat();
  },
});

export const getByRunId = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("heals")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .collect();
  },
});

export const getPending = query({
  args: { type: v.optional(healType), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 25, 1), MAX_PENDING_LIMIT);
    const target = Math.max(limit * 3, limit);
    const results = await ctx.db
      .query("heals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("asc")
      .take(target);

    const filtered = args.type
      ? results.filter((heal) => heal.type === args.type)
      : results;

    return filtered.slice(0, limit);
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("heals"),
    status: healStatus,
    patch: v.optional(nullableString),
    commitMessage: v.optional(nullableString),
    filesChanged: v.optional(v.array(v.string())),
    filesChangedWithContent: v.optional(filesChangedWithContent),
    healResult: v.optional(healResult),
    costUsd: v.optional(nullableNumber),
    inputTokens: v.optional(nullableNumber),
    outputTokens: v.optional(nullableNumber),
    failedReason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const heal = await getHealById(ctx, args.id);

    if (!heal) {
      return null;
    }

    const now = Date.now();
    const sanitizedPatch = truncateString(args.patch, MAX_PATCH_LENGTH);
    const sanitizedFiles = sanitizeFilesChangedWithContent(
      args.filesChangedWithContent
    );
    assertPayloadSize(sanitizedPatch, sanitizedFiles);
    const patch = buildPatch({
      status: args.status,
      patch: sanitizedPatch,
      commitMessage: truncateString(
        args.commitMessage,
        MAX_COMMIT_MESSAGE_LENGTH
      ),
      filesChanged: args.filesChanged,
      filesChangedWithContent: sanitizedFiles,
      healResult: args.healResult,
      costUsd: args.costUsd,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      failedReason: truncateString(args.failedReason, MAX_FAILED_REASON_LENGTH),
      updatedAt: now,
    });

    await ctx.db.patch(heal._id, patch);
    return String(heal._id);
  },
});

export const apply = mutation({
  args: { id: v.id("heals"), appliedCommitSha: v.string() },
  handler: async (ctx, args) => {
    const heal = await getHealById(ctx, args.id);
    if (!heal) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(heal._id, {
      status: "applied",
      appliedAt: now,
      appliedCommitSha:
        truncateString(args.appliedCommitSha, MAX_COMMIT_LENGTH) ??
        args.appliedCommitSha,
      updatedAt: now,
    });
    return String(heal._id);
  },
});

export const reject = mutation({
  args: {
    id: v.id("heals"),
    rejectedBy: v.string(),
    reason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const heal = await getHealById(ctx, args.id);
    if (!heal) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(heal._id, {
      status: "rejected",
      rejectedAt: now,
      rejectedBy:
        truncateString(args.rejectedBy, MAX_REJECTED_BY_LENGTH) ??
        args.rejectedBy,
      rejectionReason: truncateString(args.reason, MAX_REJECTION_REASON_LENGTH),
      updatedAt: now,
    });
    return String(heal._id);
  },
});

export const trigger = mutation({
  args: { id: v.id("heals") },
  handler: async (ctx, args) => {
    const heal = await getHealById(ctx, args.id);
    if (!heal) {
      return false;
    }
    if (heal.status !== "found") {
      return false;
    }
    await ctx.db.patch(heal._id, { status: "pending", updatedAt: Date.now() });
    return true;
  },
});

export const setCheckRunId = mutation({
  args: { id: v.id("heals"), checkRunId: v.string() },
  handler: async (ctx, args) => {
    const heal = await getHealById(ctx, args.id);
    if (!heal) {
      return null;
    }
    await ctx.db.patch(heal._id, {
      checkRunId:
        truncateString(args.checkRunId, MAX_COMMIT_LENGTH) ?? args.checkRunId,
      updatedAt: Date.now(),
    });
    return String(heal._id);
  },
});

export const markStaleAsFailed = mutation({
  args: {
    timeoutMinutes: v.number(),
    healType,
    failedReason: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.timeoutMinutes * 60 * 1000;
    const statuses: Array<"pending" | "running"> = ["pending", "running"];
    const batchSize = 200;
    const stale: Array<{
      _id: Id<"heals">;
      projectId: Id<"projects">;
      checkRunId?: string;
    }> = [];

    const reason =
      truncateString(args.failedReason, MAX_FAILED_REASON_LENGTH) ??
      "Heal timed out";
    const now = Date.now();

    for (const status of statuses) {
      while (true) {
        const candidates = await ctx.db
          .query("heals")
          .withIndex("by_status_type_updated_at", (q) =>
            q
              .eq("status", status)
              .eq("type", args.healType)
              .lt("updatedAt", cutoff)
          )
          .order("asc")
          .take(batchSize);

        if (candidates.length === 0) {
          break;
        }

        for (const heal of candidates) {
          stale.push({
            _id: heal._id,
            projectId: heal.projectId,
            checkRunId: heal.checkRunId ?? undefined,
          });

          await ctx.db.patch(heal._id, {
            status: "failed",
            failedReason: reason,
            updatedAt: now,
          });
        }
      }
    }

    if (stale.length === 0) {
      return [];
    }

    return stale.map((entry) => ({
      id: String(entry._id),
      projectId: entry.projectId,
      checkRunId: entry.checkRunId,
    }));
  },
});
