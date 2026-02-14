import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableNumber,
  nullableString,
} from "./validators";

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("waiting"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("pending"),
  v.literal("requested")
);

const jobConclusion = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("cancelled"),
  v.literal("skipped"),
  v.literal("timed_out"),
  v.literal("action_required"),
  v.literal("neutral"),
  v.literal("stale"),
  v.literal("startup_failure")
);

const jobInput = {
  providerJobId: v.string(),
  runId: v.optional(v.string()),
  repository: v.string(),
  commitSha: v.string(),
  prNumber: v.optional(nullableNumber),
  name: v.string(),
  workflowName: v.optional(nullableString),
  status: jobStatus,
  conclusion: v.optional(jobConclusion),
  hasDetent: v.boolean(),
  errorCount: v.number(),
  htmlUrl: v.optional(nullableString),
  runnerName: v.optional(nullableString),
  headBranch: v.optional(nullableString),
  queuedAt: v.optional(nullableNumber),
  startedAt: v.optional(nullableNumber),
  completedAt: v.optional(nullableNumber),
};

export const create = mutation({
  args: {
    ...jobInput,
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("jobs", args);
  },
});

export const getById = query({
  args: { id: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByRepoJob = query({
  args: { repository: v.string(), providerJobId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_repo_job", (q) =>
        q
          .eq("repository", args.repository)
          .eq("providerJobId", args.providerJobId)
      )
      .first();
  },
});

export const listByRepoCommit = query({
  args: {
    repository: v.string(),
    commitSha: v.string(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("jobs")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .take(limit);
  },
});

export const paginateByRepoCommit = query({
  args: {
    repository: v.string(),
    commitSha: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_repo_commit", (q) =>
        q.eq("repository", args.repository).eq("commitSha", args.commitSha)
      )
      .paginate(args.paginationOpts);
  },
});

export const listByRepoCommitName = query({
  args: {
    repository: v.string(),
    commitSha: v.string(),
    name: v.string(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("jobs")
      .withIndex("by_repo_commit_name", (q) =>
        q
          .eq("repository", args.repository)
          .eq("commitSha", args.commitSha)
          .eq("name", args.name)
      )
      .take(limit);
  },
});

export const listByRunId = query({
  args: { runId: v.string(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("jobs")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .take(limit);
  },
});

export const upsertByRepoJob = mutation({
  args: {
    repository: v.string(),
    providerJobId: v.string(),
    data: v.object(jobInput),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("jobs")
      .withIndex("by_repo_job", (q) =>
        q
          .eq("repository", args.repository)
          .eq("providerJobId", args.providerJobId)
      )
      .first();

    const now = Date.now();

    if (!existing) {
      const id = await ctx.db.insert("jobs", {
        ...args.data,
        createdAt: now,
        updatedAt: now,
      });
      return String(id);
    }

    await ctx.db.patch(
      existing._id,
      buildPatch({
        runId: args.data.runId,
        repository: args.data.repository,
        commitSha: args.data.commitSha,
        prNumber: args.data.prNumber,
        name: args.data.name,
        workflowName: args.data.workflowName,
        status: args.data.status,
        conclusion: args.data.conclusion,
        hasDetent: args.data.hasDetent,
        errorCount: args.data.errorCount,
        htmlUrl: args.data.htmlUrl,
        runnerName: args.data.runnerName,
        headBranch: args.data.headBranch,
        queuedAt: args.data.queuedAt,
        startedAt: args.data.startedAt,
        completedAt: args.data.completedAt,
        updatedAt: now,
      })
    );

    return String(existing._id);
  },
});

export const markDetentByRepoCommitName = mutation({
  args: {
    repository: v.string(),
    commitSha: v.string(),
    name: v.string(),
    errorCount: v.number(),
  },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_repo_commit_name", (q) =>
        q
          .eq("repository", args.repository)
          .eq("commitSha", args.commitSha)
          .eq("name", args.name)
      )
      .collect();

    if (jobs.length === 0) {
      return 0;
    }

    const now = Date.now();
    for (const job of jobs) {
      await ctx.db.patch(job._id, {
        hasDetent: true,
        errorCount: args.errorCount,
        updatedAt: now,
      });
    }

    return jobs.length;
  },
});

export const update = mutation({
  args: {
    id: v.id("jobs"),
    providerJobId: v.optional(v.string()),
    runId: v.optional(v.string()),
    repository: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    prNumber: v.optional(nullableNumber),
    name: v.optional(v.string()),
    workflowName: v.optional(nullableString),
    status: v.optional(jobStatus),
    conclusion: v.optional(jobConclusion),
    hasDetent: v.optional(v.boolean()),
    errorCount: v.optional(v.number()),
    htmlUrl: v.optional(nullableString),
    runnerName: v.optional(nullableString),
    headBranch: v.optional(nullableString),
    queuedAt: v.optional(nullableNumber),
    startedAt: v.optional(nullableNumber),
    completedAt: v.optional(nullableNumber),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);

    if (!job) {
      return null;
    }

    await ctx.db.patch(
      job._id,
      buildPatch({
        providerJobId: args.providerJobId,
        runId: args.runId,
        repository: args.repository,
        commitSha: args.commitSha,
        prNumber: args.prNumber,
        name: args.name,
        workflowName: args.workflowName,
        status: args.status,
        conclusion: args.conclusion,
        hasDetent: args.hasDetent,
        errorCount: args.errorCount,
        htmlUrl: args.htmlUrl,
        runnerName: args.runnerName,
        headBranch: args.headBranch,
        queuedAt: args.queuedAt,
        startedAt: args.startedAt,
        completedAt: args.completedAt,
        updatedAt: args.updatedAt,
      })
    );

    return String(job._id);
  },
});
