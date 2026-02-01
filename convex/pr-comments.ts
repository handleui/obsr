import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { buildPatch, clampLimit, nullableNumber } from "./validators";

export const create = mutation({
  args: {
    repository: v.string(),
    prNumber: v.number(),
    commentId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("prComments", args);
  },
});

export const getById = query({
  args: { id: v.id("prComments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByRepoPr = query({
  args: { repository: v.string(), prNumber: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("prComments")
      .withIndex("by_repo_pr", (q) =>
        q.eq("repository", args.repository).eq("prNumber", args.prNumber)
      )
      .first();
  },
});

export const listByRepository = query({
  args: { repository: v.string(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("prComments")
      .withIndex("by_repository", (q) => q.eq("repository", args.repository))
      .take(limit);
  },
});

export const upsertByRepoPr = mutation({
  args: {
    repository: v.string(),
    prNumber: v.number(),
    commentId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("prComments")
      .withIndex("by_repo_pr", (q) =>
        q.eq("repository", args.repository).eq("prNumber", args.prNumber)
      )
      .first();

    const now = Date.now();
    if (!existing) {
      const id = await ctx.db.insert("prComments", {
        repository: args.repository,
        prNumber: args.prNumber,
        commentId: args.commentId,
        createdAt: now,
        updatedAt: now,
      });
      return String(id);
    }

    await ctx.db.patch(existing._id, {
      commentId: args.commentId,
      updatedAt: now,
    });

    return String(existing._id);
  },
});

export const update = mutation({
  args: {
    id: v.id("prComments"),
    commentId: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.id);

    if (!comment) {
      return null;
    }

    await ctx.db.patch(
      comment._id,
      buildPatch({
        commentId: args.commentId,
        updatedAt: args.updatedAt,
      })
    );

    return String(comment._id);
  },
});

export const remove = mutation({
  args: { id: v.id("prComments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.id);

    if (!comment) {
      return null;
    }

    await ctx.db.delete(comment._id);
    return String(comment._id);
  },
});
