import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service_auth";
import { buildPatch, clampLimit, nullableNumber } from "./validators";

const serviceToken = v.optional(v.string());

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const { serviceToken: _serviceToken, ...data } = args;
    return await ctx.db.insert("apiKeys", data);
  },
});

export const getById = query({
  args: { id: v.id("apiKeys"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db.get(args.id);
  },
});

export const getByKeyHash = query({
  args: { keyHash: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash))
      .first();
  },
});

export const listByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    limit: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const limit = clampLimit(args.limit, 1, 200, 100);
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .take(limit);
  },
});

export const updateLastUsedAt = mutation({
  args: { id: v.id("apiKeys"), lastUsedAt: v.number(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const apiKey = await ctx.db.get(args.id);

    if (!apiKey) {
      return null;
    }

    await ctx.db.patch(apiKey._id, { lastUsedAt: args.lastUsedAt });
    return String(apiKey._id);
  },
});

export const update = mutation({
  args: {
    id: v.id("apiKeys"),
    name: v.optional(v.string()),
    lastUsedAt: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const apiKey = await ctx.db.get(args.id);

    if (!apiKey) {
      return null;
    }

    await ctx.db.patch(
      apiKey._id,
      buildPatch({
        name: args.name,
        lastUsedAt: args.lastUsedAt,
      })
    );

    return String(apiKey._id);
  },
});

export const remove = mutation({
  args: { id: v.id("apiKeys"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const apiKey = await ctx.db.get(args.id);

    if (!apiKey) {
      return null;
    }

    await ctx.db.delete(apiKey._id);
    return String(apiKey._id);
  },
});
