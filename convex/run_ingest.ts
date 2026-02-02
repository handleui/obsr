import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import {
  nullableBoolean,
  nullableNumber,
  nullableString,
  nullableStringArray,
} from "./validators";

const provider = v.union(v.literal("github"), v.literal("gitlab"));

const runPayload = v.object({
  id: v.string(),
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
});

const codeSnippet = v.object({
  lines: v.array(v.string()),
  startLine: v.number(),
  errorLine: v.number(),
  language: v.string(),
});
const nullableCodeSnippet = v.union(codeSnippet, v.null());

const errorPayload = v.object({
  runId: v.string(),
  fingerprint: v.optional(nullableString),
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
  createdAt: v.number(),
});

const signaturePayload = v.object({
  fingerprint: v.string(),
  source: v.optional(nullableString),
  ruleId: v.optional(nullableString),
  category: v.optional(nullableString),
  normalizedPattern: v.optional(nullableString),
  exampleMessage: v.optional(nullableString),
  filePath: v.optional(nullableString),
});

export const bulkStore = mutation({
  args: {
    runs: v.array(runPayload),
    errors: v.array(errorPayload),
    signatures: v.array(signaturePayload),
    projectId: v.optional(v.id("projects")),
    commitSha: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runIdMap = new Map<string, Id<"runs">>();
    const signatureMap = new Map<string, Id<"errorSignatures">>();
    const upsertRuns = async () => {
      for (const run of args.runs) {
        const existing = await ctx.db
          .query("runs")
          .withIndex("by_repo_run_attempt", (q) =>
            q
              .eq("repository", run.repository)
              .eq("runId", run.runId)
              .eq("runAttempt", run.runAttempt)
          )
          .first();
        if (existing) {
          runIdMap.set(run.id, existing._id);
          continue;
        }
        const id = await ctx.db.insert("runs", {
          projectId: run.projectId,
          provider: run.provider,
          source: run.source,
          format: run.format,
          runId: run.runId,
          repository: run.repository,
          commitSha: run.commitSha,
          prNumber: run.prNumber,
          checkRunId: run.checkRunId,
          logBytes: run.logBytes,
          errorCount: run.errorCount,
          receivedAt: run.receivedAt,
          workflowName: run.workflowName,
          conclusion: run.conclusion,
          headBranch: run.headBranch,
          runAttempt: run.runAttempt,
          runStartedAt: run.runStartedAt,
          runCompletedAt: run.runCompletedAt,
        });
        runIdMap.set(run.id, id);
      }
    };

    const upsertSignatures = async () => {
      for (const signature of args.signatures) {
        const existing = await ctx.db
          .query("errorSignatures")
          .withIndex("by_fingerprint", (q) =>
            q.eq("fingerprint", signature.fingerprint)
          )
          .first();

        if (existing) {
          signatureMap.set(signature.fingerprint, existing._id);
          continue;
        }

        const id = await ctx.db.insert("errorSignatures", {
          fingerprint: signature.fingerprint,
          source: signature.source,
          ruleId: signature.ruleId,
          category: signature.category,
          normalizedPattern: signature.normalizedPattern,
          exampleMessage: signature.exampleMessage,
          createdAt: now,
          updatedAt: now,
        });
        signatureMap.set(signature.fingerprint, id);
      }
    };

    const updateOccurrenceForSignature = async (
      signature: (typeof args.signatures)[number],
      projectId: NonNullable<typeof args.projectId>
    ) => {
      const signatureId = signatureMap.get(signature.fingerprint);
      if (!signatureId) {
        return;
      }

      const existingOccurrence = await ctx.db
        .query("errorOccurrences")
        .withIndex("by_signature_project", (q) =>
          q.eq("signatureId", signatureId).eq("projectId", projectId)
        )
        .first();

      if (!existingOccurrence) {
        await ctx.db.insert("errorOccurrences", {
          signatureId,
          projectId,
          occurrenceCount: 1,
          runCount: 1,
          firstSeenCommit: args.commitSha,
          firstSeenAt: now,
          lastSeenCommit: args.commitSha,
          lastSeenAt: now,
          commonFiles: signature.filePath ? [signature.filePath] : undefined,
        });
        return;
      }

      const commonFiles = existingOccurrence.commonFiles
        ? [...existingOccurrence.commonFiles]
        : [];
      if (
        signature.filePath &&
        !commonFiles.includes(signature.filePath) &&
        commonFiles.length < 20
      ) {
        commonFiles.push(signature.filePath);
      }

      await ctx.db.patch(existingOccurrence._id, {
        occurrenceCount: existingOccurrence.occurrenceCount + 1,
        runCount: existingOccurrence.runCount + 1,
        lastSeenCommit: args.commitSha ?? existingOccurrence.lastSeenCommit,
        lastSeenAt: now,
        commonFiles: commonFiles.length ? commonFiles : undefined,
      });
    };

    const updateOccurrences = async () => {
      const projectId = args.projectId;
      if (!projectId) {
        return;
      }

      for (const signature of args.signatures) {
        await updateOccurrenceForSignature(signature, projectId);
      }
    };

    const insertRunErrors = async () => {
      for (const error of args.errors) {
        const runId = runIdMap.get(error.runId);
        if (!runId) {
          continue;
        }

        await ctx.db.insert("runErrors", {
          runId,
          signatureId: error.fingerprint
            ? signatureMap.get(error.fingerprint)
            : undefined,
          filePath: error.filePath,
          line: error.line,
          column: error.column,
          message: error.message,
          category: error.category,
          severity: error.severity,
          ruleId: error.ruleId,
          source: error.source,
          stackTrace: error.stackTrace,
          hints: error.hints,
          workflowJob: error.workflowJob,
          workflowStep: error.workflowStep,
          workflowAction: error.workflowAction,
          unknownPattern: error.unknownPattern,
          lineKnown: error.lineKnown,
          codeSnippet: error.codeSnippet,
          possiblyTestOutput: error.possiblyTestOutput,
          fixable: error.fixable,
          createdAt: error.createdAt,
        });
      }
    };

    await upsertRuns();
    await upsertSignatures();
    await updateOccurrences();
    await insertRunErrors();

    return {
      runs: args.runs.length,
      errors: args.errors.length,
      signatures: signatureMap.size,
    };
  },
});

export const storeJobReport = mutation({
  args: {
    run: runPayload,
    errors: v.array(errorPayload),
    workflowJob: v.string(),
    source: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const source = args.source ?? "job-report";
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_repo_run_attempt", (q) =>
        q
          .eq("repository", args.run.repository)
          .eq("runId", args.run.runId)
          .eq("runAttempt", args.run.runAttempt)
      )
      .first();

    let runId: Id<"runs">;
    if (existing) {
      runId = existing._id;
      await ctx.db.patch(existing._id, {
        errorCount: args.run.errorCount,
        conclusion: args.run.conclusion,
      });
    } else {
      runId = await ctx.db.insert("runs", {
        projectId: args.run.projectId,
        provider: args.run.provider,
        source: args.run.source,
        format: args.run.format,
        runId: args.run.runId,
        repository: args.run.repository,
        commitSha: args.run.commitSha,
        prNumber: args.run.prNumber,
        checkRunId: args.run.checkRunId,
        logBytes: args.run.logBytes,
        errorCount: args.run.errorCount,
        receivedAt: args.run.receivedAt,
        workflowName: args.run.workflowName,
        conclusion: args.run.conclusion,
        headBranch: args.run.headBranch,
        runAttempt: args.run.runAttempt,
        runStartedAt: args.run.runStartedAt,
        runCompletedAt: args.run.runCompletedAt,
      });
    }

    const priorErrors = ctx.db
      .query("runErrors")
      .withIndex("by_run_id", (q) => q.eq("runId", runId));

    for await (const error of priorErrors) {
      if (error.workflowJob === args.workflowJob && error.source === source) {
        await ctx.db.delete(error._id);
      }
    }

    for (const error of args.errors) {
      await ctx.db.insert("runErrors", {
        runId,
        filePath: error.filePath,
        line: error.line,
        column: error.column,
        message: error.message,
        category: error.category,
        severity: error.severity,
        ruleId: error.ruleId,
        source,
        stackTrace: error.stackTrace,
        hints: error.hints,
        workflowJob: args.workflowJob,
        workflowStep: error.workflowStep,
        workflowAction: error.workflowAction,
        unknownPattern: error.unknownPattern,
        lineKnown: error.lineKnown,
        codeSnippet: error.codeSnippet,
        possiblyTestOutput: error.possiblyTestOutput,
        fixable: error.fixable,
        createdAt: error.createdAt,
      });
    }

    return { runId: String(runId) };
  },
});
