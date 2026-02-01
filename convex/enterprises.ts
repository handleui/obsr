import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { buildPatch, clampLimit, nullableNumber } from "./validators";

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("enterprises", {
      name: args.name,
      slug: args.slug,
      suspendedAt: args.suspendedAt,
      deletedAt: args.deletedAt,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const getById = query({
  args: { id: v.id("enterprises") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enterprises")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const list = query({
  args: { limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 200, 50);
    return await ctx.db.query("enterprises").take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("enterprises"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const enterprise = await ctx.db.get(args.id);

    if (!enterprise) {
      return null;
    }

    await ctx.db.patch(
      enterprise._id,
      buildPatch({
        name: args.name,
        slug: args.slug,
        suspendedAt: args.suspendedAt,
        deletedAt: args.deletedAt,
        updatedAt: args.updatedAt,
      })
    );

    return String(enterprise._id);
  },
});
