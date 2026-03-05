import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../client.js";
import { runErrors } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export interface RunErrorDiagnosticRow {
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  category: string | null;
  severity: string | null;
  ruleId: string | null;
  source: string | null;
  workflowJob: string | null;
}

export interface RunErrorFixableSummary {
  id: string;
  signatureId: string | null;
  source: string | null;
}

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(runErrors)
    .where(eq(runErrors.id, id))
    .limit(1);
  return row ?? null;
};

export const listByRunId = (db: Db, runId: string, limit?: number | null) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select()
    .from(runErrors)
    .where(eq(runErrors.runId, runId))
    .limit(take);
};

export const listDiagnosticRowsByRunId = (
  db: Db,
  runId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select({
      message: runErrors.message,
      filePath: runErrors.filePath,
      line: runErrors.line,
      column: runErrors.column,
      category: runErrors.category,
      severity: runErrors.severity,
      ruleId: runErrors.ruleId,
      source: runErrors.source,
      workflowJob: runErrors.workflowJob,
    })
    .from(runErrors)
    .where(eq(runErrors.runId, runId))
    .limit(take);
};

export const listFixableByRunId = (
  db: Db,
  runId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select()
    .from(runErrors)
    .where(and(eq(runErrors.runId, runId), eq(runErrors.fixable, true)))
    .limit(take);
};

export const listFixableSummariesByRunId = (
  db: Db,
  runId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select({
      id: runErrors.id,
      signatureId: runErrors.signatureId,
      source: runErrors.source,
    })
    .from(runErrors)
    .where(and(eq(runErrors.runId, runId), eq(runErrors.fixable, true)))
    .limit(take);
};

export const listBySignature = (
  db: Db,
  signatureId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select()
    .from(runErrors)
    .where(eq(runErrors.signatureId, signatureId))
    .limit(take);
};

export const listByRunIds = (
  db: Db,
  runIds: string[],
  limit?: number | null
) => {
  if (runIds.length === 0) {
    return Promise.resolve([]);
  }
  if (runIds.length === 1) {
    return listByRunId(db, runIds[0] as string, limit);
  }
  const take = clampLimit(limit, 1, 5000, 1000);
  return db
    .select()
    .from(runErrors)
    .where(inArray(runErrors.runId, runIds))
    .limit(take);
};

export const listByRunIdSource = (
  db: Db,
  runId: string,
  source: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 1000, 500);
  return db
    .select()
    .from(runErrors)
    .where(and(eq(runErrors.runId, runId), eq(runErrors.source, source)))
    .limit(take);
};

export const create = async (db: Db, data: typeof runErrors.$inferInsert) => {
  const [row] = await db.insert(runErrors).values(data).returning();
  return row as NonNullable<typeof row>;
};

export const createMany = (db: Db, data: (typeof runErrors.$inferInsert)[]) => {
  if (data.length === 0) {
    return [];
  }
  return db.insert(runErrors).values(data).returning();
};

export const update = async (
  db: Db,
  id: string,
  data: Partial<Omit<typeof runErrors.$inferInsert, "id">>
) => {
  const [row] = await db
    .update(runErrors)
    .set(data)
    .where(eq(runErrors.id, id))
    .returning();
  return row ?? null;
};
