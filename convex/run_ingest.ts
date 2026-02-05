import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
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
  logR2Key: v.optional(nullableString),
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
  codeSnippet: v.optional(nullableCodeSnippet),
  relatedFiles: v.optional(nullableStringArray),
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

const insertRun = async (
  ctx: MutationCtx,
  run: Infer<typeof runPayload>,
  runIdMap: Map<string, Id<"runs">>
) => {
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
    if (run.logR2Key && !existing.logR2Key) {
      await ctx.db.patch(existing._id, { logR2Key: run.logR2Key });
    }
    runIdMap.set(run.id, existing._id);
    return;
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
    logR2Key: run.logR2Key,
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
};

const insertSignature = async (
  ctx: MutationCtx,
  signature: Infer<typeof signaturePayload>,
  signatureMap: Map<string, Id<"errorSignatures">>,
  now: number
) => {
  const existing = await ctx.db
    .query("errorSignatures")
    .withIndex("by_fingerprint", (q) =>
      q.eq("fingerprint", signature.fingerprint)
    )
    .first();

  if (existing) {
    signatureMap.set(signature.fingerprint, existing._id);
    return;
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
};

const buildCommonFiles = (
  existing: string[] | undefined,
  filePath: string | undefined
): string[] | undefined => {
  if (!(filePath || existing?.length)) {
    return undefined;
  }
  const files = existing ? [...existing] : [];
  if (filePath && !files.includes(filePath) && files.length < 20) {
    files.push(filePath);
  }
  return files.length ? files : undefined;
};

const upsertOccurrence = async (
  ctx: MutationCtx,
  signatureId: Id<"errorSignatures">,
  projectId: Id<"projects">,
  filePath: string | undefined,
  commitSha: string | null | undefined,
  now: number
) => {
  const existing = await ctx.db
    .query("errorOccurrences")
    .withIndex("by_signature_project", (q) =>
      q.eq("signatureId", signatureId).eq("projectId", projectId)
    )
    .first();

  if (!existing) {
    await ctx.db.insert("errorOccurrences", {
      signatureId,
      projectId,
      occurrenceCount: 1,
      runCount: 1,
      firstSeenCommit: commitSha,
      firstSeenAt: now,
      lastSeenCommit: commitSha,
      lastSeenAt: now,
      commonFiles: filePath ? [filePath] : undefined,
    });
    return;
  }

  const commonFiles = buildCommonFiles(existing.commonFiles, filePath);
  await ctx.db.patch(existing._id, {
    occurrenceCount: existing.occurrenceCount + 1,
    runCount: existing.runCount + 1,
    lastSeenCommit: commitSha ?? existing.lastSeenCommit,
    lastSeenAt: now,
    commonFiles,
  });
};

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

    for (const run of args.runs) {
      await insertRun(ctx, run, runIdMap);
    }

    for (const signature of args.signatures) {
      await insertSignature(ctx, signature, signatureMap, now);
    }

    if (args.projectId) {
      for (const signature of args.signatures) {
        const signatureId = signatureMap.get(signature.fingerprint);
        if (signatureId) {
          await upsertOccurrence(
            ctx,
            signatureId,
            args.projectId,
            signature.filePath ?? undefined,
            args.commitSha,
            now
          );
        }
      }
    }

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
        codeSnippet: error.codeSnippet,
        relatedFiles: error.relatedFiles,
        fixable: error.fixable,
        createdAt: error.createdAt,
      });
    }

    return {
      runs: args.runs.length,
      errors: args.errors.length,
      signatures: signatureMap.size,
    };
  },
});

const upsertRunForJob = async (
  ctx: MutationCtx,
  run: Infer<typeof runPayload>
): Promise<Id<"runs">> => {
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
    await ctx.db.patch(existing._id, {
      errorCount: run.errorCount,
      conclusion: run.conclusion,
      ...(run.logR2Key && !existing.logR2Key ? { logR2Key: run.logR2Key } : {}),
    });
    return existing._id;
  }

  return ctx.db.insert("runs", {
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
    logR2Key: run.logR2Key,
    errorCount: run.errorCount,
    receivedAt: run.receivedAt,
    workflowName: run.workflowName,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    runAttempt: run.runAttempt,
    runStartedAt: run.runStartedAt,
    runCompletedAt: run.runCompletedAt,
  });
};

const deleteOldJobErrors = async (
  ctx: MutationCtx,
  runId: Id<"runs">,
  workflowJob: string,
  source: string
) => {
  const priorErrors = ctx.db
    .query("runErrors")
    .withIndex("by_run_id_source", (q) =>
      q.eq("runId", runId).eq("source", source)
    );

  for await (const error of priorErrors) {
    if (error.workflowJob === workflowJob) {
      await ctx.db.delete(error._id);
    }
  }
};

const insertJobErrors = async (
  ctx: MutationCtx,
  runId: Id<"runs">,
  errors: Infer<typeof errorPayload>[],
  workflowJob: string,
  source: string
) => {
  for (const error of errors) {
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
      workflowJob,
      workflowStep: error.workflowStep,
      workflowAction: error.workflowAction,
      codeSnippet: error.codeSnippet,
      relatedFiles: error.relatedFiles,
      fixable: error.fixable,
      createdAt: error.createdAt,
    });
  }
};

export const storeJobReport = mutation({
  args: {
    run: runPayload,
    errors: v.array(errorPayload),
    workflowJob: v.string(),
    source: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const source = args.source ?? "job-report";
    const runId = await upsertRunForJob(ctx, args.run);
    await deleteOldJobErrors(ctx, runId, args.workflowJob, source);
    await insertJobErrors(ctx, runId, args.errors, args.workflowJob, source);
    return { runId: String(runId) };
  },
});
