import { and, eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { runErrors } from "../schema/index.js";
import { clampLimit } from "../utils.js";

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
