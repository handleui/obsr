import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service-auth";
import {
  buildPatch,
  clampLimit,
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./validators";

const serviceToken = v.optional(v.string());

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    handle: v.string(),
    providerRepoId: v.string(),
    providerRepoName: v.string(),
    providerRepoFullName: v.string(),
    providerDefaultBranch: v.optional(nullableString),
    isPrivate: v.boolean(),
    removedAt: v.optional(nullableNumber),
    createdAt: v.number(),
    updatedAt: v.number(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db.insert("projects", {
      organizationId: args.organizationId,
      handle: args.handle,
      providerRepoId: args.providerRepoId,
      providerRepoName: args.providerRepoName,
      providerRepoFullName: args.providerRepoFullName,
      providerDefaultBranch: args.providerDefaultBranch,
      isPrivate: args.isPrivate,
      removedAt: args.removedAt,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const getById = query({
  args: { id: v.id("projects"), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db.get(args.id);
  },
});

export const listByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    includeRemoved: v.optional(nullableBoolean),
    limit: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const limit = clampLimit(args.limit, 1, 500, 200);
    const results: Record<string, unknown>[] = [];
    const query = ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId));

    for await (const project of query) {
      if (!args.includeRemoved && project.removedAt) {
        continue;
      }
      results.push(project);
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  },
});

export const countByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    includeRemoved: v.optional(nullableBoolean),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    let count = 0;
    const query = ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId));

    for await (const project of query) {
      if (!args.includeRemoved && project.removedAt) {
        continue;
      }
      count += 1;
    }

    return count;
  },
});

export const getByOrgHandle = query({
  args: {
    organizationId: v.id("organizations"),
    handle: v.string(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("projects")
      .withIndex("by_org_handle", (q) =>
        q.eq("organizationId", args.organizationId).eq("handle", args.handle)
      )
      .first();
  },
});

export const getByOrgRepo = query({
  args: {
    organizationId: v.id("organizations"),
    providerRepoId: v.string(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("projects")
      .withIndex("by_org_repo", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("providerRepoId", args.providerRepoId)
      )
      .first();
  },
});

export const getByRepoFullName = query({
  args: { providerRepoFullName: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("projects")
      .withIndex("by_repo_full_name", (q) =>
        q.eq("providerRepoFullName", args.providerRepoFullName)
      )
      .first();
  },
});

export const getByRepoId = query({
  args: { providerRepoId: v.string(), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("projects")
      .withIndex("by_repo_id", (q) =>
        q.eq("providerRepoId", args.providerRepoId)
      )
      .first();
  },
});

export const listByRepoIds = query({
  args: { providerRepoIds: v.array(v.string()), serviceToken },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const results: Record<string, unknown>[] = [];
    for (const repoId of args.providerRepoIds) {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_repo_id", (q) => q.eq("providerRepoId", repoId))
        .first();
      if (project) {
        results.push(project);
      }
    }
    return results;
  },
});

export const update = mutation({
  args: {
    id: v.id("projects"),
    handle: v.optional(v.string()),
    providerRepoId: v.optional(v.string()),
    providerRepoName: v.optional(v.string()),
    providerRepoFullName: v.optional(v.string()),
    providerDefaultBranch: v.optional(nullableString),
    isPrivate: v.optional(v.boolean()),
    removedAt: v.optional(nullableNumber),
    updatedAt: v.optional(v.number()),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const project = await ctx.db.get(args.id);

    if (!project) {
      return null;
    }

    await ctx.db.patch(
      project._id,
      buildPatch({
        handle: args.handle,
        providerRepoId: args.providerRepoId,
        providerRepoName: args.providerRepoName,
        providerRepoFullName: args.providerRepoFullName,
        providerDefaultBranch: args.providerDefaultBranch,
        isPrivate: args.isPrivate,
        removedAt: args.removedAt,
        updatedAt: args.updatedAt,
      })
    );

    return String(project._id);
  },
});

export const reactivate = mutation({
  args: {
    id: v.id("projects"),
    providerRepoName: v.optional(v.string()),
    providerRepoFullName: v.optional(v.string()),
    providerDefaultBranch: v.optional(nullableString),
    isPrivate: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const project = await ctx.db.get(args.id);

    if (!project) {
      return null;
    }

    await ctx.db.patch(project._id, {
      providerRepoName: args.providerRepoName ?? project.providerRepoName,
      providerRepoFullName:
        args.providerRepoFullName ?? project.providerRepoFullName,
      providerDefaultBranch:
        args.providerDefaultBranch ?? project.providerDefaultBranch,
      isPrivate: args.isPrivate ?? project.isPrivate,
      removedAt: undefined,
      updatedAt: args.updatedAt ?? Date.now(),
    });

    return String(project._id);
  },
});

const repoSnapshot = v.object({
  id: v.string(),
  name: v.string(),
  fullName: v.string(),
  defaultBranch: v.optional(nullableString),
  isPrivate: v.boolean(),
});

export const syncFromGitHub = mutation({
  args: {
    organizationId: v.id("organizations"),
    repos: v.array(repoSnapshot),
    syncRemoved: v.optional(nullableBoolean),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const now = Date.now();
    const syncRemoved = args.syncRemoved ?? true;

    const existing = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const existingByRepoId = new Map(
      existing.map((project) => [project.providerRepoId, project])
    );

    const repoIds = new Set(args.repos.map((repo) => repo.id));

    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const repo of args.repos) {
      const project = existingByRepoId.get(repo.id);
      if (!project) {
        await ctx.db.insert("projects", {
          organizationId: args.organizationId,
          handle: repo.name.toLowerCase(),
          providerRepoId: repo.id,
          providerRepoName: repo.name,
          providerRepoFullName: repo.fullName,
          providerDefaultBranch: repo.defaultBranch,
          isPrivate: repo.isPrivate,
          createdAt: now,
          updatedAt: now,
        });
        added += 1;
        continue;
      }

      const wasRemoved = Boolean(project.removedAt);
      const needsUpdate =
        project.providerRepoName !== repo.name ||
        project.providerRepoFullName !== repo.fullName ||
        project.providerDefaultBranch !== repo.defaultBranch ||
        project.isPrivate !== repo.isPrivate;

      if (wasRemoved || needsUpdate) {
        await ctx.db.patch(project._id, {
          providerRepoName: repo.name,
          providerRepoFullName: repo.fullName,
          providerDefaultBranch: repo.defaultBranch,
          isPrivate: repo.isPrivate,
          removedAt: undefined,
          updatedAt: now,
        });
        updated += 1;
      }
    }

    if (syncRemoved) {
      for (const project of existing) {
        if (project.removedAt) {
          continue;
        }
        if (!repoIds.has(project.providerRepoId)) {
          await ctx.db.patch(project._id, {
            removedAt: now,
            updatedAt: now,
          });
          removed += 1;
        }
      }
    }

    return { added, updated, removed };
  },
});

export const clearRemovedByOrg = mutation({
  args: {
    organizationId: v.id("organizations"),
    updatedAt: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const now = args.updatedAt ?? Date.now();
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    let updated = 0;
    for (const project of projects) {
      if (!project.removedAt) {
        continue;
      }
      await ctx.db.patch(project._id, {
        removedAt: null,
        updatedAt: now,
      });
      updated += 1;
    }

    return { updated };
  },
});

export const softDeleteByRepoIds = mutation({
  args: {
    providerRepoIds: v.array(v.string()),
    removedAt: v.optional(nullableNumber),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const now = args.removedAt ?? Date.now();
    let updated = 0;

    for (const repoId of args.providerRepoIds) {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_repo_id", (q) => q.eq("providerRepoId", repoId))
        .first();

      if (!project || project.removedAt) {
        continue;
      }

      await ctx.db.patch(project._id, {
        removedAt: now,
        updatedAt: now,
      });
      updated += 1;
    }

    return { updated };
  },
});
