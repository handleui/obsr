import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { buildPatch, nullableBoolean, nullableNumber } from "./validators";

export const create = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("commitJobStats", args);
  },
});

export const getById = query({
  args: { id: v.id("commitJobStats") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByRepoCommit = query({
  args: { repository: v.string(), commitSha: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commitJobStats")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .first();
  },
});

export const setCommentPostedByRepoCommit = mutation({
  args: {
    repository: v.string(),
    commitSha: v.string(),
    commentPosted: v.optional(nullableBoolean),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("commitJobStats")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .first();

    if (!existing) {
      return null;
    }

    await ctx.db.patch(existing._id, {
      commentPosted: args.commentPosted ?? true,
      updatedAt: Date.now(),
    });

    return String(existing._id);
  },
});

export const upsert = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("commitJobStats")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .first();

    if (!existing) {
      return await ctx.db.insert("commitJobStats", args);
    }

    await ctx.db.patch(
      existing._id,
      buildPatch({
        prNumber: args.prNumber,
        totalJobs: args.totalJobs,
        completedJobs: args.completedJobs,
        failedJobs: args.failedJobs,
        detentJobs: args.detentJobs,
        totalErrors: args.totalErrors,
        commentPosted: args.commentPosted,
        updatedAt: args.updatedAt,
      })
    );

    return existing._id;
  },
});

export const update = mutation({
  args: {
    id: v.id("commitJobStats"),
    prNumber: v.optional(nullableNumber),
    totalJobs: v.optional(v.number()),
    completedJobs: v.optional(v.number()),
    failedJobs: v.optional(v.number()),
    detentJobs: v.optional(v.number()),
    totalErrors: v.optional(v.number()),
    commentPosted: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const stats = await ctx.db.get(args.id);

    if (!stats) {
      return null;
    }

    await ctx.db.patch(
      stats._id,
      buildPatch({
        prNumber: args.prNumber,
        totalJobs: args.totalJobs,
        completedJobs: args.completedJobs,
        failedJobs: args.failedJobs,
        detentJobs: args.detentJobs,
        totalErrors: args.totalErrors,
        commentPosted: args.commentPosted,
        updatedAt: args.updatedAt,
      })
    );

    return String(stats._id);
  },
});
