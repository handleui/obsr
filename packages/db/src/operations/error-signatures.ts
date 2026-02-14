import { and, eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { errorSignatures } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(errorSignatures)
    .where(eq(errorSignatures.id, id))
    .limit(1);
  return row ?? null;
};

export const getByFingerprint = async (db: Db, fingerprint: string) => {
  const [row] = await db
    .select()
    .from(errorSignatures)
    .where(eq(errorSignatures.fingerprint, fingerprint))
    .limit(1);
  return row ?? null;
};

export const listBySourceRule = (
  db: Db,
  source: string,
  ruleId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(errorSignatures)
    .where(
      and(
        eq(errorSignatures.source, source),
        eq(errorSignatures.ruleId, ruleId)
      )
    )
    .limit(take);
};

export const create = async (
  db: Db,
  data: typeof errorSignatures.$inferInsert
) => {
  const [row] = await db.insert(errorSignatures).values(data).returning();
  return row as NonNullable<typeof row>;
};

export const update = async (
  db: Db,
  id: string,
  data: Partial<Omit<typeof errorSignatures.$inferInsert, "id">>
) => {
  const [row] = await db
    .update(errorSignatures)
    .set(data)
    .where(eq(errorSignatures.id, id))
    .returning();
  return row ?? null;
};
