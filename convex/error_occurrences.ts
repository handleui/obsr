import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./validators";

export const create = mutation({
  args: {
    signatureId: v.id("errorSignatures"),
    projectId: v.id("projects"),
    occurrenceCount: v.number(),
    runCount: v.number(),
    firstSeenCommit: v.optional(nullableString),
    firstSeenAt: v.number(),
    lastSeenCommit: v.optional(nullableString),
    lastSeenAt: v.number(),
    fixedAt: v.optional(nullableNumber),
    fixedByCommit: v.optional(nullableString),
    fixVerified: v.optional(nullableBoolean),
    commonFiles: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("errorOccurrences", args);
  },
});

export const getById = query({
  args: { id: v.id("errorOccurrences") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySignatureProject = query({
  args: { signatureId: v.id("errorSignatures"), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("errorOccurrences")
      .withIndex("by_signature_project", (q) =>
        q.eq("signatureId", args.signatureId).eq("projectId", args.projectId)
      )
      .first();
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("errorOccurrences")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(limit);
  },
});

export const listByLastSeen = query({
  args: { limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("errorOccurrences")
      .withIndex("by_last_seen", (q) => q)
      .order("desc")
      .take(limit);
  },
});

export const upsert = mutation({
  args: {
    signatureId: v.id("errorSignatures"),
    projectId: v.id("projects"),
    seenAt: v.number(),
    commit: v.optional(nullableString),
    filePath: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("errorOccurrences")
      .withIndex("by_signature_project", (q) =>
        q.eq("signatureId", args.signatureId).eq("projectId", args.projectId)
      )
      .first();

    if (!existing) {
      return await ctx.db.insert("errorOccurrences", {
        signatureId: args.signatureId,
        projectId: args.projectId,
        occurrenceCount: 1,
        runCount: 1,
        firstSeenCommit: args.commit,
        firstSeenAt: args.seenAt,
        lastSeenCommit: args.commit,
        lastSeenAt: args.seenAt,
        commonFiles: args.filePath ? [args.filePath] : undefined,
      });
    }

    const commonFiles = existing.commonFiles ? [...existing.commonFiles] : [];
    if (
      args.filePath &&
      !commonFiles.includes(args.filePath) &&
      commonFiles.length < 20
    ) {
      commonFiles.push(args.filePath);
    }

    await ctx.db.patch(existing._id, {
      occurrenceCount: existing.occurrenceCount + 1,
      runCount: existing.runCount + 1,
      lastSeenCommit: args.commit ?? existing.lastSeenCommit,
      lastSeenAt: args.seenAt,
      commonFiles: commonFiles.length ? commonFiles : undefined,
    });

    return existing._id;
  },
});

export const update = mutation({
  args: {
    id: v.id("errorOccurrences"),
    occurrenceCount: v.optional(v.number()),
    runCount: v.optional(v.number()),
    firstSeenCommit: v.optional(nullableString),
    firstSeenAt: v.optional(v.number()),
    lastSeenCommit: v.optional(nullableString),
    lastSeenAt: v.optional(v.number()),
    fixedAt: v.optional(nullableNumber),
    fixedByCommit: v.optional(nullableString),
    fixVerified: v.optional(nullableBoolean),
    commonFiles: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const occurrence = await ctx.db.get(args.id);

    if (!occurrence) {
      return null;
    }

    await ctx.db.patch(
      occurrence._id,
      buildPatch({
        occurrenceCount: args.occurrenceCount,
        runCount: args.runCount,
        firstSeenCommit: args.firstSeenCommit,
        firstSeenAt: args.firstSeenAt,
        lastSeenCommit: args.lastSeenCommit,
        lastSeenAt: args.lastSeenAt,
        fixedAt: args.fixedAt,
        fixedByCommit: args.fixedByCommit,
        fixVerified: args.fixVerified,
        commonFiles: args.commonFiles,
      })
    );

    return String(occurrence._id);
  },
});
