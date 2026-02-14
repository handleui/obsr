import { and, desc, eq, gte, inArray, like } from "drizzle-orm";

import type { Db } from "../client.js";
import { runs } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export const getById = async (db: Db, id: string) => {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
};

export const getByProviderRun = async (
  db: Db,
  provider: "github" | "gitlab",
  runId: string
) => {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.provider, provider), eq(runs.runId, runId)))
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
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.receivedAt))
    .limit(take);
};

export const getLatestByProjectPr = async (
  db: Db,
  projectId: string,
  prNumber: number
) => {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.prNumber, prNumber)))
    .orderBy(desc(runs.receivedAt))
    .limit(1);
  return row ?? null;
};

export const listByRepoCommit = (
  db: Db,
  repository: string,
  commitSha: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.repository, repository), eq(runs.commitSha, commitSha)))
    .limit(take);
};

export const listByRepository = (
  db: Db,
  repository: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 2000, 500);
  return db
    .select()
    .from(runs)
    .where(eq(runs.repository, repository))
    .limit(take);
};

const escapeLikePattern = (value: string): string =>
  value.replace(/[%_\\]/g, (ch) => `\\${ch}`);

export const listByRepoCommitPrefix = async (
  db: Db,
  repository: string,
  commitPrefix: string,
  limit?: number | null
) => {
  const prefix = commitPrefix.toLowerCase();
  const take = clampLimit(limit, 1, 5000, 2000);

  if (!prefix || prefix.length > 40) {
    return { runs: [], isTruncated: false };
  }

  const results = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.repository, repository),
        like(runs.commitSha, `${escapeLikePattern(prefix)}%`)
      )
    )
    .limit(take + 1);

  return {
    runs: results.slice(0, take),
    isTruncated: results.length > take,
  };
};

export const listByRepositoryRunIds = (
  db: Db,
  repository: string,
  runIds: string[],
  limit?: number | null
) => {
  if (runIds.length === 0) {
    return [];
  }
  const take = clampLimit(limit, 1, 5000, 2000);
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.repository, repository), inArray(runs.runId, runIds)))
    .limit(take);
};

export const listByProjectSince = (
  db: Db,
  projectId: string,
  since: number,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 2000, 500);
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), gte(runs.receivedAt, since)))
    .orderBy(desc(runs.receivedAt))
    .limit(take);
};

export const listByRepoRunAttempt = (
  db: Db,
  repository: string,
  runId: string,
  runAttempt: number,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 100, 10);
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.repository, repository),
        eq(runs.runId, runId),
        eq(runs.runAttempt, runAttempt)
      )
    )
    .limit(take);
};

export const listByPrNumber = (
  db: Db,
  prNumber: number,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(runs)
    .where(eq(runs.prNumber, prNumber))
    .orderBy(desc(runs.receivedAt))
    .limit(take);
};

export const create = async (db: Db, data: typeof runs.$inferInsert) => {
  const [row] = await db.insert(runs).values(data).returning();
  return row as NonNullable<typeof row>;
};

export const update = async (
  db: Db,
  id: string,
  data: Partial<Omit<typeof runs.$inferInsert, "id">>
) => {
  const [row] = await db
    .update(runs)
    .set(data)
    .where(eq(runs.id, id))
    .returning();
  return row ?? null;
};
