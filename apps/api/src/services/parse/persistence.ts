import type { InferInsertModel } from "drizzle-orm";
import { createDb } from "../../db/client";
import { runErrors, runs } from "../../db/schema";
import type { Env } from "../../types/env";
import type {
  ApiExtractedError,
  ParseResult,
  ParseSource,
  Provider,
  ValidatedParseRequest,
} from "./types";

interface PersistenceResult {
  persisted: boolean;
}

interface RunMetadata {
  projectId?: string;
  provider: Provider | null;
  source: ParseSource;
  format: string;
  runId?: string;
  repository?: string;
  commitSha?: string;
  logBytes: number;
  errorCount: number;
}

type RunErrorInsert = InferInsertModel<typeof runErrors>;

// PostgreSQL has a 65,535 parameter limit. Each runErrors row has ~25 columns.
// Max ~2,621 rows per insert. Using 2000 for safe margin.
const BATCH_SIZE = 2000;

const mapErrorToRow = (
  error: ApiExtractedError,
  runRecordId: string
): RunErrorInsert => ({
  id: crypto.randomUUID(),
  runId: runRecordId,
  filePath: error.filePath,
  line: error.line,
  column: error.column,
  message: error.message,
  category: error.category,
  severity: error.severity,
  ruleId: error.ruleId,
  source: error.source,
  stackTrace: error.stackTrace,
  suggestions: error.suggestions ? [...error.suggestions] : undefined,
  hint: error.hint,
  workflowJob: error.workflowJob ?? error.workflowContext?.job,
  workflowStep: error.workflowContext?.step,
  workflowAction: error.workflowContext?.action,
  unknownPattern: error.unknownPattern,
  lineKnown: error.lineKnown,
  columnKnown: error.columnKnown,
  messageTruncated: error.messageTruncated,
  stackTraceTruncated: error.stackTraceTruncated,
  codeSnippet: error.codeSnippet
    ? {
        ...error.codeSnippet,
        lines: [...error.codeSnippet.lines],
      }
    : undefined,
  exitCode: error.exitCode,
  isInfrastructure: error.isInfrastructure,
  possiblyTestOutput: error.possiblyTestOutput,
});

export const persistParseRun = async (
  env: Env,
  result: ParseResult,
  request: ValidatedParseRequest
): Promise<PersistenceResult> => {
  const metadata: RunMetadata = {
    projectId: request.projectId,
    provider:
      request.provider ??
      (result.metadata.source === "unknown" ? null : result.metadata.source),
    source: result.metadata.source,
    format: result.metadata.format,
    runId: request.runId,
    repository: request.repository,
    commitSha: request.commitSha,
    logBytes: result.metadata.logBytes,
    errorCount: result.metadata.errorCount,
  };

  try {
    const { db, client } = await createDb(env);
    try {
      const runRecordId = crypto.randomUUID();
      const errorRows = result.errors.map((error) =>
        mapErrorToRow(error, runRecordId)
      );

      await db.transaction(async (tx) => {
        await tx.insert(runs).values({
          id: runRecordId,
          projectId: metadata.projectId,
          provider: metadata.provider,
          source: metadata.source,
          format: metadata.format,
          runId: metadata.runId,
          repository: metadata.repository,
          commitSha: metadata.commitSha,
          logBytes: metadata.logBytes,
          errorCount: metadata.errorCount,
        });

        for (let i = 0; i < errorRows.length; i += BATCH_SIZE) {
          const batch = errorRows.slice(i, i + BATCH_SIZE);
          await tx.insert(runErrors).values(batch);
        }
      });

      return { persisted: true };
    } finally {
      await client.end();
    }
  } catch (error) {
    const errorType =
      error instanceof Error ? error.constructor.name : typeof error;
    console.error(`[parse] persistence failed (${errorType})`, error);
    return { persisted: false };
  }
};
