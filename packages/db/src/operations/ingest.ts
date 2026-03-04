import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  errorOccurrences,
  errorSignatures,
  runErrors,
} from "../schema/errors.js";
import { runs } from "../schema/runs.js";
import { commonFilesMergeFromExcludedSql } from "../utils.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_ERRORS_PER_JOB = 500;
const MAX_WORKFLOW_JOB_LENGTH = 255;
const MAX_LOG_MANIFEST_SEGMENTS = 1000;
const MAX_SEGMENT_LINE_NUMBER = 1_000_000;
const MAX_SIGNATURE_SOURCE_LENGTH = 200;
const MAX_SIGNATURE_RULE_ID_LENGTH = 200;
const MAX_SIGNATURE_CATEGORY_LENGTH = 100;
const MAX_SIGNATURE_PATTERN_LENGTH = 500;
const MAX_SIGNATURE_MESSAGE_LENGTH = 500;
const MAX_SIGNATURE_FILE_PATH_LENGTH = 1000;

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

const isInLineRange = (n: number) =>
  Number.isInteger(n) && n >= 1 && n <= MAX_SEGMENT_LINE_NUMBER;

const isValidSegment = (seg: LogSegment): boolean => {
  if (typeof seg.start !== "number" || typeof seg.end !== "number") {
    return false;
  }
  if (typeof seg.signal !== "boolean") {
    return false;
  }
  return (
    isInLineRange(seg.start) && isInLineRange(seg.end) && seg.start <= seg.end
  );
};

export const validateLogManifest = (
  segments: LogSegment[] | null | undefined,
  truncatedHint?: boolean
): ValidatedLogManifest => {
  if (!segments || segments.length === 0) {
    return {
      segments: segments?.length === 0 ? [] : undefined,
      truncated: truncatedHint ?? false,
    };
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

type ExtractionStatus = "success" | "failed" | "timeout" | "skipped";
type Provider = "github" | "gitlab";

interface RunPayload {
  id: string;
  projectId: string;
  provider: Provider;
  source?: string | null;
  format?: string | null;
  runId: string;
  repository: string;
  commitSha?: string | null;
  prNumber?: number | null;
  checkRunId?: string | null;
  logBytes?: number | null;
  logR2Key?: string | null;
  logManifest?: LogSegment[];
  logManifestTruncated?: boolean;
  errorCount?: number | null;
  receivedAt: number;
  workflowName?: string | null;
  conclusion?: string | null;
  headBranch?: string | null;
  extractionStatus?: ExtractionStatus | null;
  runAttempt: number;
  runStartedAt?: number | null;
  runCompletedAt?: number | null;
}

interface CodeSnippet {
  lines: string[];
  startLine: number;
  errorLine: number;
  language: string;
}

interface ErrorPayload {
  runId: string;
  fingerprint?: string | null;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  category?: string | null;
  severity?: string | null;
  ruleId?: string | null;
  source?: string | null;
  stackTrace?: string | null;
  hints?: string[] | null;
  workflowJob?: string | null;
  codeSnippet?: CodeSnippet | null;
  relatedFiles?: string[] | null;
  fixable?: boolean | null;
  logLineStart?: number | null;
  logLineEnd?: number | null;
  createdAt: number;
}

interface SignaturePayload {
  fingerprint: string;
  source?: string | null;
  ruleId?: string | null;
  category?: string | null;
  normalizedPattern?: string | null;
  exampleMessage?: string | null;
  filePath?: string | null;
}

interface JobReportArgs {
  run: RunPayload;
  errors: ErrorPayload[];
  signatures?: SignaturePayload[];
  workflowJob: string;
  source?: string | null;
}

const toRunFields = (run: RunPayload) => {
  const { id: _id, logManifest, logManifestTruncated, ...rest } = run;
  const { segments, truncated } = validateLogManifest(
    logManifest,
    logManifestTruncated
  );
  return {
    ...rest,
    logManifest: segments ?? null,
    logManifestTruncated: truncated || null,
  };
};

interface RunPatch {
  logR2Key?: string;
  logManifest?: LogSegment[] | null;
  logManifestTruncated?: true;
  extractionStatus?: ExtractionStatus;
}

const buildRunPatch = (
  run: RunPayload,
  existing: {
    logR2Key?: string | null;
    logManifest?: unknown;
    extractionStatus?: string | null;
  }
): RunPatch => {
  const patch: RunPatch = {};
  if (run.logR2Key && !existing.logR2Key) {
    patch.logR2Key = run.logR2Key;
  }
  if (run.logManifest && !existing.logManifest) {
    const { segments, truncated } = validateLogManifest(
      run.logManifest,
      run.logManifestTruncated
    );
    patch.logManifest = segments ?? null;
    if (truncated) {
      patch.logManifestTruncated = true;
    }
  }
  if (run.extractionStatus && !existing.extractionStatus) {
    patch.extractionStatus = run.extractionStatus;
  }
  return patch;
};

const toErrorFields = (error: ErrorPayload) => {
  const { runId: _runId, fingerprint: _fingerprint, ...fields } = error;
  return fields;
};

const upsertRun = async (tx: Tx, runPayload: RunPayload): Promise<string> => {
  const [existingRun] = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.repository, runPayload.repository),
        eq(runs.runId, runPayload.runId),
        eq(runs.runAttempt, runPayload.runAttempt)
      )
    )
    .limit(1);

  if (existingRun) {
    const patch = {
      ...buildRunPatch(runPayload, existingRun),
      errorCount: runPayload.errorCount,
      conclusion: runPayload.conclusion,
    };
    await tx.update(runs).set(patch).where(eq(runs.id, existingRun.id));
    return existingRun.id;
  }

  const fields = toRunFields(runPayload);
  const rows = await tx.insert(runs).values(fields).returning({ id: runs.id });
  return rows[0]?.id ?? fields.runId;
};

const insertSignatures = async (
  tx: Tx,
  signatures: SignaturePayload[],
  now: number
): Promise<Map<string, string>> => {
  const signatureMap = new Map<string, string>();
  if (signatures.length === 0) {
    return signatureMap;
  }

  const values = signatures.map((sig) => ({
    fingerprint: sig.fingerprint,
    source: truncateField(sig.source, MAX_SIGNATURE_SOURCE_LENGTH) ?? null,
    ruleId: truncateField(sig.ruleId, MAX_SIGNATURE_RULE_ID_LENGTH) ?? null,
    category:
      truncateField(sig.category, MAX_SIGNATURE_CATEGORY_LENGTH) ?? null,
    normalizedPattern:
      truncateField(sig.normalizedPattern, MAX_SIGNATURE_PATTERN_LENGTH) ??
      null,
    exampleMessage:
      truncateField(sig.exampleMessage, MAX_SIGNATURE_MESSAGE_LENGTH) ?? null,
    createdAt: now,
    updatedAt: now,
  }));

  const rows = await tx
    .insert(errorSignatures)
    .values(values)
    .onConflictDoUpdate({
      target: errorSignatures.fingerprint,
      set: { updatedAt: now },
    })
    .returning({
      id: errorSignatures.id,
      fingerprint: errorSignatures.fingerprint,
    });

  for (const row of rows) {
    signatureMap.set(row.fingerprint, row.id);
  }

  return signatureMap;
};

const buildOccurrenceRows = (
  signatures: SignaturePayload[],
  signatureMap: Map<string, string>,
  projectId: string,
  commitSha: string | null | undefined,
  now: number
) =>
  signatures
    .map((sig) => {
      const signatureId = signatureMap.get(sig.fingerprint);
      if (!signatureId) {
        return null;
      }
      const filePath =
        truncateField(sig.filePath, MAX_SIGNATURE_FILE_PATH_LENGTH) ??
        undefined;
      return {
        signatureId,
        projectId,
        occurrenceCount: 1,
        runCount: 1,
        firstSeenCommit: commitSha ?? null,
        firstSeenAt: now,
        lastSeenCommit: commitSha ?? null,
        lastSeenAt: now,
        commonFiles: filePath ? [filePath] : null,
        filePath,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

const upsertOccurrences = async (
  tx: Tx,
  signatures: SignaturePayload[],
  signatureMap: Map<string, string>,
  projectId: string,
  commitSha: string | null | undefined,
  now: number
): Promise<void> => {
  const rows = buildOccurrenceRows(
    signatures,
    signatureMap,
    projectId,
    commitSha,
    now
  );
  if (rows.length === 0) {
    return;
  }

  const insertRows = rows.map(({ filePath: _fp, ...rest }) => rest);
  await tx
    .insert(errorOccurrences)
    .values(insertRows)
    .onConflictDoUpdate({
      target: [errorOccurrences.signatureId, errorOccurrences.projectId],
      set: {
        occurrenceCount: sql`${errorOccurrences.occurrenceCount} + 1`,
        runCount: sql`${errorOccurrences.runCount} + 1`,
        lastSeenCommit: commitSha ?? sql`${errorOccurrences.lastSeenCommit}`,
        lastSeenAt: now,
        commonFiles: commonFilesMergeFromExcludedSql(),
      },
    });
};

const capErrors = (errors: ErrorPayload[]) => {
  if (errors.length <= MAX_ERRORS_PER_JOB) {
    return errors;
  }
  console.warn(
    `[ingest] storeJobReport: truncated ${errors.length} errors to ${MAX_ERRORS_PER_JOB}`
  );
  return errors.slice(0, MAX_ERRORS_PER_JOB);
};

const insertRunErrors = async (
  tx: Tx,
  errors: ErrorPayload[],
  ctx: {
    runId: string;
    source: string;
    workflowJob: string;
    signatureMap: Map<string, string>;
  }
) => {
  if (errors.length === 0) {
    return;
  }
  const errorRows = errors.map((error) => ({
    runId: ctx.runId,
    signatureId: error.fingerprint
      ? (ctx.signatureMap.get(error.fingerprint) ?? null)
      : null,
    ...toErrorFields(error),
    source: ctx.source,
    workflowJob: ctx.workflowJob,
  }));
  await tx.insert(runErrors).values(errorRows);
};

export const storeJobReport = async (
  db: Db,
  args: JobReportArgs
): Promise<{ runId: string }> =>
  db.transaction(async (tx) => {
    const now = Date.now();
    const source = args.source ?? "job-report";
    const workflowJob =
      truncateField(args.workflowJob, MAX_WORKFLOW_JOB_LENGTH) ??
      args.workflowJob;
    const cappedErrors = capErrors(args.errors);
    const runPayload = { ...args.run, errorCount: cappedErrors.length };

    const runId = await upsertRun(tx, runPayload);

    await tx
      .delete(runErrors)
      .where(
        and(
          eq(runErrors.runId, runId),
          eq(runErrors.source, source),
          eq(runErrors.workflowJob, workflowJob)
        )
      );

    let signatureMap = new Map<string, string>();
    const cappedSignatures = args.signatures?.slice(0, MAX_ERRORS_PER_JOB);
    if (cappedSignatures?.length) {
      signatureMap = await insertSignatures(tx, cappedSignatures, now);
      await upsertOccurrences(
        tx,
        cappedSignatures,
        signatureMap,
        args.run.projectId,
        args.run.commitSha,
        now
      );
    }

    await insertRunErrors(tx, cappedErrors, {
      runId,
      source,
      workflowJob,
      signatureMap,
    });

    return { runId };
  });
