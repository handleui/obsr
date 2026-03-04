import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service_auth";
import {
  buildPatch,
  clampLimit,
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./validators";

const provider = v.union(v.literal("github"), v.literal("gitlab"));
const accountType = v.union(v.literal("organization"), v.literal("user"));
const serviceToken = v.optional(v.string());

const organizationSettings = v.object({
  enableInlineAnnotations: v.optional(nullableBoolean),
  enablePrComments: v.optional(nullableBoolean),
  autofixEnabled: v.optional(nullableBoolean),
  autofixAutoCommit: v.optional(nullableBoolean),
  resolveAutoCommit: v.optional(nullableBoolean),
  resolveAutoTrigger: v.optional(nullableBoolean),
  healBudgetPerRunUsd: v.optional(nullableNumber),
  validationEnabled: v.optional(nullableBoolean),
});

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    enterpriseId: v.optional(v.union(v.id("enterprises"), v.null())),
    provider,
    providerAccountId: v.string(),
    providerAccountLogin: v.string(),
    providerAccountType: accountType,
    providerAvatarUrl: v.optional(nullableString),
    providerInstallationId: v.optional(nullableString),
    providerAccessTokenEncrypted: v.optional(nullableString),
    providerAccessTokenExpiresAt: v.optional(nullableNumber),
    providerWebhookSecret: v.optional(nullableString),
    installerGithubId: v.optional(nullableString),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    lastSyncedAt: v.optional(nullableNumber),
    settings: organizationSettings,
    polarCustomerId: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const { serviceToken: _, ...data } = args;
    return await ctx.db.insert("organizations", data);
  },
});

export const getById = query({
  args: { id: v.id("organizations"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db.get(args.id);
  },
});

export const getBySlug = query({
  args: { slug: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const getByProviderAccount = query({
  args: { provider, providerAccountId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_provider_account", (q) =>
        q
          .eq("provider", args.provider)
          .eq("providerAccountId", args.providerAccountId)
      )
      .first();
  },
});

export const getByProviderAccountLogin = query({
  args: { provider, providerAccountLogin: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_provider_account_login", (q) =>
        q
          .eq("provider", args.provider)
          .eq("providerAccountLogin", args.providerAccountLogin)
      )
      .first();
  },
});

export const listByProviderAccountIds = query({
  args: {
    provider,
    providerAccountIds: v.array(v.string()),
    includeDeleted: v.optional(nullableBoolean),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const results: Record<string, unknown>[] = [];
    for (const accountId of args.providerAccountIds) {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_provider_account", (q) =>
          q.eq("provider", args.provider).eq("providerAccountId", accountId)
        )
        .first();
      if (!org || (!args.includeDeleted && org.deletedAt)) {
        continue;
      }
      results.push(org);
    }
    return results;
  },
});

export const listByInstallerGithubId = query({
  args: { installerGithubId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_installer_github", (q) =>
        q.eq("installerGithubId", args.installerGithubId)
      )
      .take(100);
  },
});

export const listByEnterprise = query({
  args: { enterpriseId: v.id("enterprises"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_enterprise", (q) =>
        q.eq("enterpriseId", args.enterpriseId)
      )
      .take(500);
  },
});

export const listByProviderInstallationId = query({
  args: { providerInstallationId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizations")
      .withIndex("by_provider_installation", (q) =>
        q.eq("providerInstallationId", args.providerInstallationId)
      )
      .take(10);
  },
});

export const list = query({
  args: { limit: v.optional(nullableNumber), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const limit = clampLimit(args.limit, 1, 200, 50);
    return await ctx.db.query("organizations").take(limit);
  },
});

export const listActiveGithub = query({
  args: { limit: v.optional(nullableNumber), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const limit = clampLimit(args.limit, 1, 5000, 500);
    const all = await ctx.db.query("organizations").take(5000);
    const filtered = all.filter(
      (org) =>
        org.provider === "github" &&
        !org.deletedAt &&
        !org.suspendedAt &&
        org.providerInstallationId
    );
    filtered.sort((a, b) => (a.lastSyncedAt ?? 0) - (b.lastSyncedAt ?? 0));
    return filtered.slice(0, limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("organizations"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    enterpriseId: v.optional(v.union(v.id("enterprises"), v.null())),
    provider: v.optional(provider),
    providerAccountId: v.optional(v.string()),
    providerAccountLogin: v.optional(v.string()),
    providerAccountType: v.optional(accountType),
    providerAvatarUrl: v.optional(nullableString),
    providerInstallationId: v.optional(nullableString),
    providerAccessTokenEncrypted: v.optional(nullableString),
    providerAccessTokenExpiresAt: v.optional(nullableNumber),
    providerWebhookSecret: v.optional(nullableString),
    installerGithubId: v.optional(nullableString),
    suspendedAt: v.optional(nullableNumber),
    deletedAt: v.optional(nullableNumber),
    lastSyncedAt: v.optional(nullableNumber),
    settings: v.optional(organizationSettings),
    polarCustomerId: v.optional(nullableString),
    updatedAt: v.optional(v.number()),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const organization = await ctx.db.get(args.id);

    if (!organization) {
      return null;
    }

    const { id: _, serviceToken: _s, ...patch } = args;
    await ctx.db.patch(organization._id, buildPatch(patch));

    return String(organization._id);
  },
});
