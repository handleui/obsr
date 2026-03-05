import { and, asc, eq, gt } from "drizzle-orm";

import type { Db } from "../client.js";
import { jobs } from "../schema/index.js";

interface UpsertJobInput {
  repository: string;
  providerJobId: string;
  data: {
    providerJobId: string;
    runId?: string;
    repository: string;
    commitSha: string;
    prNumber?: number;
    name: string;
    workflowName?: string;
    status:
      | "queued"
      | "waiting"
      | "in_progress"
      | "completed"
      | "pending"
      | "requested";
    conclusion?:
      | "success"
      | "failure"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "neutral"
      | "stale"
      | "startup_failure";
    hasDetent: boolean;
    errorCount: number;
    htmlUrl?: string;
    runnerName?: string;
    headBranch?: string;
    queuedAt?: number;
    startedAt?: number;
    completedAt?: number;
  };
}

interface PaginateByRepoCommitInput {
  repository: string;
  commitSha: string;
  paginationOpts: {
    cursor: string | null;
    numItems: number;
  };
}

const toDate = (value: number | null | undefined): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Date(value);
};

export const upsertByRepoJob = async (db: Db, input: UpsertJobInput) =>
  db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.repository, input.repository),
          eq(jobs.providerJobId, input.providerJobId)
        )
      )
      .limit(1);

    const now = new Date();

    if (!existing) {
      const [created] = await tx
        .insert(jobs)
        .values({
          providerJobId: input.data.providerJobId,
          runId: input.data.runId,
          repository: input.data.repository,
          commitSha: input.data.commitSha,
          prNumber: input.data.prNumber,
          name: input.data.name,
          workflowName: input.data.workflowName,
          status: input.data.status,
          conclusion: input.data.conclusion,
          hasDetent: input.data.hasDetent,
          errorCount: input.data.errorCount,
          htmlUrl: input.data.htmlUrl,
          runnerName: input.data.runnerName,
          headBranch: input.data.headBranch,
          queuedAt: toDate(input.data.queuedAt),
          startedAt: toDate(input.data.startedAt),
          completedAt: toDate(input.data.completedAt),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: jobs.id });
      return created?.id ?? null;
    }

    const [updated] = await tx
      .update(jobs)
      .set({
        providerJobId: input.data.providerJobId,
        runId: input.data.runId,
        repository: input.data.repository,
        commitSha: input.data.commitSha,
        prNumber: input.data.prNumber,
        name: input.data.name,
        workflowName: input.data.workflowName,
        status: input.data.status,
        conclusion: input.data.conclusion,
        hasDetent: input.data.hasDetent,
        errorCount: input.data.errorCount,
        htmlUrl: input.data.htmlUrl,
        runnerName: input.data.runnerName,
        headBranch: input.data.headBranch,
        queuedAt: toDate(input.data.queuedAt),
        startedAt: toDate(input.data.startedAt),
        completedAt: toDate(input.data.completedAt),
        updatedAt: now,
      })
      .where(eq(jobs.id, existing.id))
      .returning({ id: jobs.id });

    return updated?.id ?? null;
  });

export const markDetentByRepoCommitName = async (
  db: Db,
  repository: string,
  commitSha: string,
  name: string,
  errorCount: number
) => {
  const rows = await db
    .update(jobs)
    .set({ hasDetent: true, errorCount, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.repository, repository),
        eq(jobs.commitSha, commitSha),
        eq(jobs.name, name)
      )
    )
    .returning({ id: jobs.id });

  return rows.length;
};

export const paginateByRepoCommit = async (
  db: Db,
  input: PaginateByRepoCommitInput
) => {
  const limit = Math.min(Math.max(input.paginationOpts.numItems, 1), 500);
  const conditions = [
    eq(jobs.repository, input.repository),
    eq(jobs.commitSha, input.commitSha),
  ];

  if (input.paginationOpts.cursor) {
    conditions.push(gt(jobs.createdAt, new Date(input.paginationOpts.cursor)));
  }

  const rows = await db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(asc(jobs.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    page,
    continueCursor:
      rows.length > limit ? (last?.createdAt.toISOString() ?? null) : null,
    isDone: rows.length <= limit,
  };
};
