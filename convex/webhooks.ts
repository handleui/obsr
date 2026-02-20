import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service_auth";
import { buildPatch, clampLimit, nullableNumber } from "./validators";

const serviceToken = v.optional(v.string());

const webhookEvent = v.union(
  v.literal("heal.pending"),
  v.literal("heal.running"),
  v.literal("heal.completed"),
  v.literal("heal.applied"),
  v.literal("heal.rejected"),
  v.literal("heal.failed")
);

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    url: v.string(),
    name: v.string(),
    events: v.array(webhookEvent),
    secretEncrypted: v.string(),
    secretPrefix: v.string(),
    active: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const { serviceToken: _serviceToken, active, ...rest } = args;
    return await ctx.db.insert("webhooks", {
      ...rest,
      active: active ?? true,
    });
  },
});

export const getById = query({
  args: { id: v.id("webhooks"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db.get(args.id);
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
    const limit = clampLimit(args.limit, 1, 50, 50);
    return await ctx.db
      .query("webhooks")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .take(limit);
  },
});

export const listActiveByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("webhooks")
      .withIndex("by_org_active", (q) =>
        q.eq("organizationId", args.organizationId).eq("active", true)
      )
      .take(50);
  },
});

export const update = mutation({
  args: {
    id: v.id("webhooks"),
    url: v.optional(v.string()),
    name: v.optional(v.string()),
    events: v.optional(v.array(webhookEvent)),
    active: v.optional(v.boolean()),
    updatedAt: v.number(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const webhook = await ctx.db.get(args.id);

    if (!webhook) {
      return null;
    }

    await ctx.db.patch(
      webhook._id,
      buildPatch({
        url: args.url,
        name: args.name,
        events: args.events,
        active: args.active,
        updatedAt: args.updatedAt,
      })
    );

    return String(webhook._id);
  },
});

export const remove = mutation({
  args: { id: v.id("webhooks"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const webhook = await ctx.db.get(args.id);

    if (!webhook) {
      return null;
    }

    await ctx.db.delete(webhook._id);
    return String(webhook._id);
  },
});
