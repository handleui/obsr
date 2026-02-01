import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableBoolean,
  nullableNumber,
  nullableString,
  nullableStringArray,
} from "./validators";

const codeSnippet = v.object({
  lines: v.array(v.string()),
  startLine: v.number(),
  errorLine: v.number(),
  language: v.string(),
});
const nullableCodeSnippet = v.union(codeSnippet, v.null());

const errorPayload = v.object({
  runId: v.id("runs"),
  filePath: v.optional(nullableString),
  line: v.optional(nullableNumber),
  column: v.optional(nullableNumber),
  message: v.string(),
  category: v.optional(nullableString),
  severity: v.optional(nullableString),
  ruleId: v.optional(nullableString),
  source: v.optional(nullableString),
  stackTrace: v.optional(nullableString),
  hints: v.optional(nullableStringArray),
  workflowJob: v.optional(nullableString),
  workflowStep: v.optional(nullableString),
  workflowAction: v.optional(nullableString),
  unknownPattern: v.optional(nullableBoolean),
  lineKnown: v.optional(nullableBoolean),
  codeSnippet: v.optional(nullableCodeSnippet),
  possiblyTestOutput: v.optional(nullableBoolean),
  fixable: v.optional(nullableBoolean),
  signatureId: v.optional(v.id("errorSignatures")),
  createdAt: v.number(),
});

export const create = mutation({
  args: errorPayload,
  handler: async (ctx, args) => {
    return await ctx.db.insert("runErrors", args);
  },
});

export const createMany = mutation({
  args: { errors: v.array(errorPayload) },
  handler: async (ctx, args) => {
    const ids: string[] = [];
    for (const error of args.errors) {
      const id = await ctx.db.insert("runErrors", error);
      ids.push(String(id));
    }
    return ids;
  },
});

export const getById = query({
  args: { id: v.id("runErrors") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listByRunId = query({
  args: { runId: v.id("runs"), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 500);
    return await ctx.db
      .query("runErrors")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .take(limit);
  },
});

export const listFixableByRunId = query({
  args: { runId: v.id("runs"), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 500);
    return await ctx.db
      .query("runErrors")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .filter((q) => q.eq(q.field("fixable"), true))
      .take(limit);
  },
});

export const listBySignature = query({
  args: {
    signatureId: v.id("errorSignatures"),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 500);
    return await ctx.db
      .query("runErrors")
      .withIndex("by_signature", (q) => q.eq("signatureId", args.signatureId))
      .take(limit);
  },
});

export const listByRunIdSource = query({
  args: {
    runId: v.id("runs"),
    source: v.string(),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 1000, 500);
    return await ctx.db
      .query("runErrors")
      .withIndex("by_run_id_source", (q) =>
        q.eq("runId", args.runId).eq("source", args.source)
      )
      .take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("runErrors"),
    filePath: v.optional(nullableString),
    line: v.optional(nullableNumber),
    column: v.optional(nullableNumber),
    message: v.optional(v.string()),
    category: v.optional(nullableString),
    severity: v.optional(nullableString),
    ruleId: v.optional(nullableString),
    source: v.optional(nullableString),
    stackTrace: v.optional(nullableString),
    hints: v.optional(nullableStringArray),
    workflowJob: v.optional(nullableString),
    workflowStep: v.optional(nullableString),
    workflowAction: v.optional(nullableString),
    unknownPattern: v.optional(nullableBoolean),
    lineKnown: v.optional(nullableBoolean),
    codeSnippet: v.optional(nullableCodeSnippet),
    possiblyTestOutput: v.optional(nullableBoolean),
    fixable: v.optional(nullableBoolean),
    signatureId: v.optional(v.id("errorSignatures")),
  },
  handler: async (ctx, args) => {
    const error = await ctx.db.get(args.id);

    if (!error) {
      return null;
    }

    await ctx.db.patch(
      error._id,
      buildPatch({
        filePath: args.filePath,
        line: args.line,
        column: args.column,
        message: args.message,
        category: args.category,
        severity: args.severity,
        ruleId: args.ruleId,
        source: args.source,
        stackTrace: args.stackTrace,
        hints: args.hints,
        workflowJob: args.workflowJob,
        workflowStep: args.workflowStep,
        workflowAction: args.workflowAction,
        unknownPattern: args.unknownPattern,
        lineKnown: args.lineKnown,
        codeSnippet: args.codeSnippet,
        possiblyTestOutput: args.possiblyTestOutput,
        fixable: args.fixable,
        signatureId: args.signatureId,
      })
    );

    return String(error._id);
  },
});
