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

const MAX_ERRORS_PER_JOB = 500;
const MAX_PROVIDER_JOB_ID_LENGTH = 64;
const MAX_WORKFLOW_JOB_LENGTH = 255;
const MAX_LOG_MANIFEST_SEGMENTS = 1000;
const MAX_SEGMENT_LINE_NUMBER = 1_000_000;

const truncateField = (
  value: string | null | undefined,
  maxLen: number
): string | null | undefined => {
  if (value == null) {
    return value;
  }
  return value.length > maxLen ? value.slice(0, maxLen) : value;
};

interface LogSegment {
  start: number;
  end: number;
  signal: boolean;
}

interface ValidatedLogManifest {
  segments: LogSegment[] | undefined;
  truncated: boolean;
}

const isValidSegment = (seg: LogSegment): boolean => {
  if (
    typeof seg.start !== "number" ||
    typeof seg.end !== "number" ||
    typeof seg.signal !== "boolean"
  ) {
    return false;
  }
  if (!(Number.isInteger(seg.start) && Number.isInteger(seg.end))) {
    return false;
  }
  const inRange = (n: number) => n >= 1 && n <= MAX_SEGMENT_LINE_NUMBER;
  return inRange(seg.start) && inRange(seg.end) && seg.start <= seg.end;
};

export const validateLogManifest = (
  segments: LogSegment[] | null | undefined,
  truncatedHint?: boolean
): ValidatedLogManifest => {
  if (!segments || segments.length === 0) {
    return { segments: undefined, truncated: truncatedHint ?? false };
  }

  let truncated = truncatedHint ?? false;
  let toValidate = segments;

  if (segments.length > MAX_LOG_MANIFEST_SEGMENTS) {
    toValidate = segments.slice(0, MAX_LOG_MANIFEST_SEGMENTS);
    truncated = true;
  }

  const validated = toValidate.filter(isValidSegment);
  return {
    segments: validated.length > 0 ? validated : undefined,
    truncated,
  };
};

const provider = v.union(v.literal("github"), v.literal("gitlab"));
// Keep in sync with apps/api/src/services/webhooks/error-extraction.ts and convex/schema.ts
const extractionStatus = v.union(
  v.literal("success"),
  v.literal("failed"),
  v.literal("timeout"),
  v.literal("skipped")
);

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
  logManifest: v.optional(
    v.array(
      v.object({
        start: v.number(),
        end: v.number(),
        signal: v.boolean(),
      })
    )
  ),
  logManifestTruncated: v.optional(v.boolean()),
  errorCount: v.optional(nullableNumber),
  receivedAt: v.number(),
  workflowName: v.optional(nullableString),
  conclusion: v.optional(nullableString),
  headBranch: v.optional(nullableString),
  extractionStatus: v.optional(v.union(extractionStatus, v.null())),
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
  providerJobId: v.optional(nullableString),
  workflowJob: v.optional(nullableString),
  workflowStep: v.optional(nullableString),
  workflowAction: v.optional(nullableString),
  codeSnippet: v.optional(nullableCodeSnippet),
  relatedFiles: v.optional(nullableStringArray),
  fixable: v.optional(nullableBoolean),
  logLineStart: v.optional(nullableNumber),
  logLineEnd: v.optional(nullableNumber),
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

const toRunFields = (run: Infer<typeof runPayload>) => {
  const { id: _id, logManifest, logManifestTruncated, ...rest } = run;
  const { segments, truncated } = validateLogManifest(
    logManifest,
    logManifestTruncated
  );
  return {
    ...rest,
    logManifest: segments ?? undefined,
    logManifestTruncated: truncated || undefined,
  };
};

const findExistingRun = (ctx: MutationCtx, run: Infer<typeof runPayload>) =>
  ctx.db
    .query("runs")
    .withIndex("by_repo_run_attempt", (q) =>
      q
        .eq("repository", run.repository)
        .eq("runId", run.runId)
        .eq("runAttempt", run.runAttempt)
    )
    .first();

const buildRunPatch = (
  run: Infer<typeof runPayload>,
  existing: {
    logR2Key?: string | null;
    logManifest?: unknown;
    extractionStatus?: string | null;
  }
): Partial<{
  logR2Key: string;
  logManifest: Infer<typeof runPayload>["logManifest"];
  logManifestTruncated: true;
  extractionStatus: Infer<typeof extractionStatus>;
}> => {
  const patch: Partial<{
    logR2Key: string;
    logManifest: Infer<typeof runPayload>["logManifest"];
    logManifestTruncated: true;
    extractionStatus: Infer<typeof extractionStatus>;
  }> = {};
  if (run.logR2Key && !existing.logR2Key) {
    patch.logR2Key = run.logR2Key;
  }
  if (run.logManifest && !existing.logManifest) {
    const { segments, truncated } = validateLogManifest(
      run.logManifest,
      run.logManifestTruncated
    );
    patch.logManifest = segments ?? undefined;
    if (truncated) {
      patch.logManifestTruncated = true;
    }
  }
  if (run.extractionStatus && !existing.extractionStatus) {
    patch.extractionStatus = run.extractionStatus;
  }
  return patch;
};

const insertRun = async (
  ctx: MutationCtx,
  run: Infer<typeof runPayload>,
  runIdMap: Map<string, Id<"runs">>
) => {
  const existing = await findExistingRun(ctx, run);
  if (!existing) {
    const id = await ctx.db.insert("runs", toRunFields(run));
    runIdMap.set(run.id, id);
    return;
  }

  const patch = buildRunPatch(run, existing);
  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(existing._id, patch);
  }
  runIdMap.set(run.id, existing._id);
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

const toErrorFields = (error: Infer<typeof errorPayload>) => {
  const { runId: _runId, fingerprint: _fingerprint, ...fields } = error;
  return fields;
};

const upsertSignatureOccurrences = async (
  ctx: MutationCtx,
  signatures: Infer<typeof signaturePayload>[],
  signatureMap: Map<string, Id<"errorSignatures">>,
  projectId: Id<"projects">,
  commitSha: string | null | undefined,
  now: number
) => {
  for (const sig of signatures) {
    const signatureId = signatureMap.get(sig.fingerprint);
    if (!signatureId) {
      continue;
    }
    await upsertOccurrence(
      ctx,
      signatureId,
      projectId,
      sig.filePath ?? undefined,
      commitSha,
      now
    );
  }
};

const insertBulkErrors = async (
  ctx: MutationCtx,
  errors: Infer<typeof errorPayload>[],
  runIdMap: Map<string, Id<"runs">>,
  signatureMap: Map<string, Id<"errorSignatures">>
) => {
  for (const error of errors) {
    const runId = runIdMap.get(error.runId);
    if (!runId) {
      continue;
    }

    await ctx.db.insert("runErrors", {
      runId,
      signatureId: error.fingerprint
        ? signatureMap.get(error.fingerprint)
        : undefined,
      ...toErrorFields(error),
    });
  }
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
      await upsertSignatureOccurrences(
        ctx,
        args.signatures,
        signatureMap,
        args.projectId,
        args.commitSha,
        now
      );
    }
    await insertBulkErrors(ctx, args.errors, runIdMap, signatureMap);

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
  const existing = await findExistingRun(ctx, run);
  if (!existing) {
    return ctx.db.insert("runs", toRunFields(run));
  }

  const patch = {
    ...buildRunPatch(run, existing),
    // Always overwrite: job reports refine these on each invocation
    errorCount: run.errorCount,
    conclusion: run.conclusion,
  };
  await ctx.db.patch(existing._id, patch);
  return existing._id;
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
  source: string,
  providerJobId?: string
) => {
  for (const error of errors) {
    await ctx.db.insert("runErrors", {
      runId,
      ...toErrorFields(error),
      source,
      providerJobId: providerJobId ?? error.providerJobId,
      workflowJob,
    });
  }
};

export const storeJobReport = mutation({
  args: {
    run: runPayload,
    errors: v.array(errorPayload),
    workflowJob: v.string(),
    providerJobId: v.optional(nullableString),
    source: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const source = args.source ?? "job-report";
    const workflowJob =
      truncateField(args.workflowJob, MAX_WORKFLOW_JOB_LENGTH) ??
      args.workflowJob;
    const sanitizedJobId =
      truncateField(args.providerJobId, MAX_PROVIDER_JOB_ID_LENGTH) ??
      undefined;
    const cappedErrors = args.errors.slice(0, MAX_ERRORS_PER_JOB);
    if (args.errors.length > MAX_ERRORS_PER_JOB) {
      console.warn(
        `[run_ingest] storeJobReport: truncated ${args.errors.length} errors to ${MAX_ERRORS_PER_JOB}`
      );
    }
    const runPayload = { ...args.run, errorCount: cappedErrors.length };
    const runId = await upsertRunForJob(ctx, runPayload);
    await deleteOldJobErrors(ctx, runId, workflowJob, source);
    await insertJobErrors(
      ctx,
      runId,
      cappedErrors,
      workflowJob,
      source,
      sanitizedJobId
    );
    return { runId: String(runId) };
  },
});
