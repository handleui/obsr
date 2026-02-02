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
    fingerprint: v.string(),
    source: v.optional(nullableString),
    ruleId: v.optional(nullableString),
    category: v.optional(nullableString),
    normalizedPattern: v.optional(nullableString),
    exampleMessage: v.optional(nullableString),
    loreCandidate: v.optional(nullableBoolean),
    loreSyncedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("errorSignatures", args);
  },
});

export const getById = query({
  args: { id: v.id("errorSignatures") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByFingerprint = query({
  args: { fingerprint: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("errorSignatures")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", args.fingerprint))
      .first();
  },
});

export const listBySourceRule = query({
  args: {
    source: v.string(),
    ruleId: v.string(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("errorSignatures")
      .withIndex("by_source_rule", (q) =>
        q.eq("source", args.source).eq("ruleId", args.ruleId)
      )
      .take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("errorSignatures"),
    fingerprint: v.optional(v.string()),
    source: v.optional(nullableString),
    ruleId: v.optional(nullableString),
    category: v.optional(nullableString),
    normalizedPattern: v.optional(nullableString),
    exampleMessage: v.optional(nullableString),
    loreCandidate: v.optional(nullableBoolean),
    loreSyncedAt: v.optional(nullableNumber),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const signature = await ctx.db.get(args.id);

    if (!signature) {
      return null;
    }

    await ctx.db.patch(
      signature._id,
      buildPatch({
        fingerprint: args.fingerprint,
        source: args.source,
        ruleId: args.ruleId,
        category: args.category,
        normalizedPattern: args.normalizedPattern,
        exampleMessage: args.exampleMessage,
        loreCandidate: args.loreCandidate,
        loreSyncedAt: args.loreSyncedAt,
        updatedAt: args.updatedAt,
      })
    );

    return String(signature._id);
  },
});
