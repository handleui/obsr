import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableNumber,
  nullableString,
} from "./validators";

const provider = v.union(v.literal("github"), v.literal("gitlab"));

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    provider,
    source: v.optional(nullableString),
    format: v.optional(nullableString),
    runId: v.string(),
    repository: v.string(),
    commitSha: v.optional(nullableString),
    prNumber: v.optional(nullableNumber),
    checkRunId: v.optional(nullableString),
    logBytes: v.optional(nullableNumber),
    errorCount: v.optional(nullableNumber),
    receivedAt: v.number(),
    workflowName: v.optional(nullableString),
    conclusion: v.optional(nullableString),
    headBranch: v.optional(nullableString),
    runAttempt: v.number(),
    runStartedAt: v.optional(nullableNumber),
    runCompletedAt: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("runs", {
      projectId: args.projectId,
      provider: args.provider,
      source: args.source,
      format: args.format,
      runId: args.runId,
      repository: args.repository,
      commitSha: args.commitSha,
      prNumber: args.prNumber,
      checkRunId: args.checkRunId,
      logBytes: args.logBytes,
      errorCount: args.errorCount,
      receivedAt: args.receivedAt,
      workflowName: args.workflowName,
      conclusion: args.conclusion,
      headBranch: args.headBranch,
      runAttempt: args.runAttempt,
      runStartedAt: args.runStartedAt,
      runCompletedAt: args.runCompletedAt,
    });
  },
});

export const getById = query({
  args: { id: v.id("runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByProviderRun = query({
  args: { provider, runId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_provider_run", (q) =>
        q.eq("provider", args.provider).eq("runId", args.runId)
      )
      .first();
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(limit);
  },
});

export const getLatestByProjectPr = query({
  args: {
    projectId: v.id("projects"),
    prNumber: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_project_pr_received_at", (q) =>
        q.eq("projectId", args.projectId).eq("prNumber", args.prNumber)
      )
      .order("desc")
      .first();
  },
});

export const listByRepoCommit = query({
  args: { repository: v.string(), commitSha: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .collect();
  },
});

export const listByRepository = query({
  args: { repository: v.string(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 2000, 500);
    return await ctx.db
      .query("runs")
      .withIndex("by_repo_commit", (q) => q.eq("repository", args.repository))
      .take(limit);
  },
});

export const listByRepoCommitPrefix = query({
  args: {
    repository: v.string(),
    commitPrefix: v.string(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const prefix = args.commitPrefix.toLowerCase();
    const limit = clampLimit(args.limit, 1, 5000, 2000);
    if (!prefix || prefix.length > 40) {
      return { runs: [], isTruncated: false };
    }

    const upperBound = `${prefix}g`;
    const results = await ctx.db
      .query("runs")
      .withIndex("by_repo_commit", (q) =>
        q
          .eq("repository", args.repository)
          .gte("commitSha", prefix)
          .lt("commitSha", upperBound)
      )
      .take(limit + 1);

    return {
      runs: results.slice(0, limit),
      isTruncated: results.length > limit,
    };
  },
});

export const listByRepositoryRunIds = query({
  args: { repository: v.string(), runIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const results: Record<string, unknown>[] = [];
    for (const runId of args.runIds) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_repo_run_attempt", (q) =>
          q.eq("repository", args.repository).eq("runId", runId)
        )
        .collect();
      results.push(...runs);
    }
    return results;
  },
});

export const listByProjectSince = query({
  args: {
    projectId: v.id("projects"),
    since: v.number(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 2000, 500);
    return await ctx.db
      .query("runs")
      .withIndex("by_project_received_at", (q) =>
        q.eq("projectId", args.projectId).gte("receivedAt", args.since)
      )
      .order("desc")
      .take(limit);
  },
});

export const listByRepoRunAttempt = query({
  args: { repository: v.string(), runId: v.string(), runAttempt: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_repo_run_attempt", (q) =>
        q
          .eq("repository", args.repository)
          .eq("runId", args.runId)
          .eq("runAttempt", args.runAttempt)
      )
      .collect();
  },
});

export const listByPrNumber = query({
  args: { prNumber: v.number(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("runs")
      .withIndex("by_pr_number", (q) => q.eq("prNumber", args.prNumber))
      .order("desc")
      .take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("runs"),
    projectId: v.optional(v.id("projects")),
    provider: v.optional(provider),
    source: v.optional(nullableString),
    format: v.optional(nullableString),
    runId: v.optional(v.string()),
    repository: v.optional(v.string()),
    commitSha: v.optional(nullableString),
    prNumber: v.optional(nullableNumber),
    checkRunId: v.optional(nullableString),
    logBytes: v.optional(nullableNumber),
    errorCount: v.optional(nullableNumber),
    receivedAt: v.optional(v.number()),
    workflowName: v.optional(nullableString),
    conclusion: v.optional(nullableString),
    headBranch: v.optional(nullableString),
    runAttempt: v.optional(v.number()),
    runStartedAt: v.optional(nullableNumber),
    runCompletedAt: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.id);

    if (!run) {
      return null;
    }

    await ctx.db.patch(
      run._id,
      buildPatch({
        projectId: args.projectId,
        provider: args.provider,
        source: args.source,
        format: args.format,
        runId: args.runId,
        repository: args.repository,
        commitSha: args.commitSha,
        prNumber: args.prNumber,
        checkRunId: args.checkRunId,
        logBytes: args.logBytes,
        errorCount: args.errorCount,
        receivedAt: args.receivedAt,
        workflowName: args.workflowName,
        conclusion: args.conclusion,
        headBranch: args.headBranch,
        runAttempt: args.runAttempt,
        runStartedAt: args.runStartedAt,
        runCompletedAt: args.runCompletedAt,
      })
    );

    return String(run._id);
  },
});
