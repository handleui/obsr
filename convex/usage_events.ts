import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableNumber,
  nullableString,
} from "./validators";

const usageEventName = v.union(v.literal("ai"), v.literal("sandbox"));
const usageMetadata = v.object({
  runId: v.optional(nullableString),
  model: v.optional(nullableString),
  inputTokens: v.optional(nullableNumber),
  outputTokens: v.optional(nullableNumber),
  cacheReadTokens: v.optional(nullableNumber),
  cacheWriteTokens: v.optional(nullableNumber),
  durationMinutes: v.optional(nullableNumber),
  costUSD: v.optional(nullableNumber),
});

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    eventName: usageEventName,
    metadata: v.optional(usageMetadata),
    polarIngested: v.boolean(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("usageEvents", args);
  },
});

export const getById = query({
  args: { id: v.id("usageEvents") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 200);
    return await ctx.db
      .query("usageEvents")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(limit);
  },
});

export const listByOrgSince = query({
  args: {
    organizationId: v.id("organizations"),
    since: v.number(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 5000, 500);
    return await ctx.db
      .query("usageEvents")
      .withIndex("by_org_created_at", (q) =>
        q.eq("organizationId", args.organizationId).gte("createdAt", args.since)
      )
      .order("desc")
      .take(limit);
  },
});

export const listByPolarIngested = query({
  args: {
    polarIngested: v.boolean(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 200);
    return await ctx.db
      .query("usageEvents")
      .withIndex("by_polar_ingested_created_at", (q) =>
        q.eq("polarIngested", args.polarIngested)
      )
      .order("asc")
      .take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("usageEvents"),
    metadata: v.optional(usageMetadata),
    polarIngested: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.id);

    if (!event) {
      return null;
    }

    await ctx.db.patch(
      event._id,
      buildPatch({
        metadata: args.metadata,
        polarIngested: args.polarIngested,
      })
    );

    return String(event._id);
  },
});
