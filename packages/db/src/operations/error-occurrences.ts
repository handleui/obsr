import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { errorOccurrences } from "../schema/index.js";
import { clampLimit, commonFilesMergeSql } from "../utils.js";

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(errorOccurrences)
    .where(eq(errorOccurrences.id, id))
    .limit(1);
  return row ?? null;
};

export const getBySignatureProject = async (
  db: Db,
  signatureId: string,
  projectId: string
) => {
  const [row] = await db
    .select()
    .from(errorOccurrences)
    .where(
      and(
        eq(errorOccurrences.signatureId, signatureId),
        eq(errorOccurrences.projectId, projectId)
      )
    )
    .limit(1);
  return row ?? null;
};

export const listByProject = (
  db: Db,
  projectId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(errorOccurrences)
    .where(eq(errorOccurrences.projectId, projectId))
    .limit(take);
};

export const listByLastSeen = (db: Db, limit?: number | null) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(errorOccurrences)
    .orderBy(desc(errorOccurrences.lastSeenAt))
    .limit(take);
};

export const create = async (
  db: Db,
  data: typeof errorOccurrences.$inferInsert
) => {
  const [row] = await db.insert(errorOccurrences).values(data).returning();
  return row as NonNullable<typeof row>;
};

export const upsert = async (
  db: Db,
  data: {
    signatureId: string;
    projectId: string;
    seenAt: number;
    commit?: string | null;
    filePath?: string | null;
  }
) => {
  const filePathArray = data.filePath ? [data.filePath] : undefined;

  const [row] = await db
    .insert(errorOccurrences)
    .values({
      signatureId: data.signatureId,
      projectId: data.projectId,
      occurrenceCount: 1,
      runCount: 1,
      firstSeenCommit: data.commit,
      firstSeenAt: data.seenAt,
      lastSeenCommit: data.commit,
      lastSeenAt: data.seenAt,
      commonFiles: filePathArray,
    })
    .onConflictDoUpdate({
      target: [errorOccurrences.signatureId, errorOccurrences.projectId],
      set: {
        occurrenceCount: sql`${errorOccurrences.occurrenceCount} + 1`,
        runCount: sql`${errorOccurrences.runCount} + 1`,
        lastSeenCommit: data.commit ?? sql`${errorOccurrences.lastSeenCommit}`,
        lastSeenAt: data.seenAt,
        commonFiles: commonFilesMergeSql(data.filePath ?? undefined),
      },
    })
    .returning();
  return row as NonNullable<typeof row>;
};

export const update = async (
  db: Db,
  id: string,
  data: Partial<Omit<typeof errorOccurrences.$inferInsert, "id">>
) => {
  const [row] = await db
    .update(errorOccurrences)
    .set(data)
    .where(eq(errorOccurrences.id, id))
    .returning();
  return row ?? null;
};
