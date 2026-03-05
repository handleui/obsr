import { and, eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { prComments } from "../schema/index.js";

export const getByRepoPr = async (
  db: Db,
  repository: string,
  prNumber: number
) => {
  const [row] = await db
    .select()
    .from(prComments)
    .where(
      and(
        eq(prComments.repository, repository),
        eq(prComments.prNumber, prNumber)
      )
    )
    .limit(1);

  return row ?? null;
};

export const upsertByRepoPr = async (
  db: Db,
  repository: string,
  prNumber: number,
  commentId: string
) => {
  const existing = await getByRepoPr(db, repository, prNumber);
  const now = new Date();

  if (!existing) {
    const [created] = await db
      .insert(prComments)
      .values({
        repository,
        prNumber,
        commentId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: prComments.id });

    return created?.id ?? null;
  }

  const [updated] = await db
    .update(prComments)
    .set({ commentId, updatedAt: now })
    .where(eq(prComments.id, existing.id))
    .returning({ id: prComments.id });

  return updated?.id ?? null;
};
