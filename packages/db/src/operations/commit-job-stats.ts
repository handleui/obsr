import { and, eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { commitJobStats } from "../schema/index.js";

interface UpsertCommitJobStatsInput {
  repository: string;
  commitSha: string;
  prNumber?: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  detentJobs: number;
  totalErrors: number;
  commentPosted: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export const getByRepoCommit = async (
  db: Db,
  repository: string,
  commitSha: string
) => {
  const [row] = await db
    .select()
    .from(commitJobStats)
    .where(
      and(
        eq(commitJobStats.repository, repository),
        eq(commitJobStats.commitSha, commitSha)
      )
    )
    .limit(1);

  return row ?? null;
};

export const setCommentPostedByRepoCommit = async (
  db: Db,
  repository: string,
  commitSha: string,
  commentPosted?: boolean | null
) => {
  const [row] = await db
    .update(commitJobStats)
    .set({
      commentPosted: commentPosted ?? true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitJobStats.repository, repository),
        eq(commitJobStats.commitSha, commitSha)
      )
    )
    .returning({ id: commitJobStats.id });

  return row?.id ?? null;
};

export const upsert = async (db: Db, input: UpsertCommitJobStatsInput) => {
  const existing = await getByRepoCommit(db, input.repository, input.commitSha);

  if (!existing) {
    const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
    const [row] = await db
      .insert(commitJobStats)
      .values({
        repository: input.repository,
        commitSha: input.commitSha,
        prNumber: input.prNumber,
        totalJobs: input.totalJobs,
        completedJobs: input.completedJobs,
        failedJobs: input.failedJobs,
        detentJobs: input.detentJobs,
        totalErrors: input.totalErrors,
        commentPosted: input.commentPosted,
        createdAt,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
      })
      .returning({ id: commitJobStats.id });

    return row?.id ?? null;
  }

  const [updated] = await db
    .update(commitJobStats)
    .set({
      prNumber: input.prNumber,
      totalJobs: input.totalJobs,
      completedJobs: input.completedJobs,
      failedJobs: input.failedJobs,
      detentJobs: input.detentJobs,
      totalErrors: input.totalErrors,
      commentPosted: input.commentPosted,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(commitJobStats.id, existing.id))
    .returning({ id: commitJobStats.id });

  return updated?.id ?? null;
};
