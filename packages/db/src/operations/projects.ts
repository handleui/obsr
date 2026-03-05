import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { projects } from "../schema/index.js";
import { clampLimit } from "../utils.js";

interface ListByOrgOptions {
  organizationId: string;
  includeRemoved?: boolean;
  limit?: number | null;
}

interface CreateProjectInput {
  organizationId: string;
  handle: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  providerDefaultBranch?: string | null;
  isPrivate: boolean;
  removedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

interface UpdateProjectInput {
  id: string;
  organizationId?: string;
  handle?: string;
  providerRepoId?: string;
  providerRepoName?: string;
  providerRepoFullName?: string;
  providerDefaultBranch?: string | null;
  isPrivate?: boolean;
  removedAt?: number | null;
  updatedAt?: number;
}

interface ReactivateProjectInput {
  id: string;
  providerRepoName?: string;
  providerRepoFullName?: string;
  providerDefaultBranch?: string | null;
  isPrivate?: boolean;
  updatedAt?: number;
}

interface RepoSnapshot {
  id: string;
  name: string;
  fullName: string;
  defaultBranch?: string | null;
  isPrivate: boolean;
}

interface SyncFromGitHubInput {
  organizationId: string;
  repos: RepoSnapshot[];
  syncRemoved?: boolean | null;
}

interface SoftDeleteByRepoIdsInput {
  providerRepoIds: string[];
  removedAt?: number;
}

interface SoftDeleteByOrgRepoIdsInput extends SoftDeleteByRepoIdsInput {
  organizationId: string;
}

type TxLike = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

const toDate = (value: number | null | undefined): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Date(value);
};

const withProjectLock = async (db: TxLike, key: string) => {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`project:${key}`}))`
  );
};

const needsProjectUpdate = (
  project: {
    providerRepoName: string;
    providerRepoFullName: string;
    providerDefaultBranch: string | null;
    isPrivate: boolean;
  },
  repo: RepoSnapshot
): boolean =>
  project.providerRepoName !== repo.name ||
  project.providerRepoFullName !== repo.fullName ||
  project.providerDefaultBranch !== (repo.defaultBranch ?? null) ||
  project.isPrivate !== repo.isPrivate;

const syncRepos = async (
  tx: TxLike,
  input: SyncFromGitHubInput,
  existingByRepoId: Map<string, typeof projects.$inferSelect>,
  now: Date
): Promise<{ added: number; updated: number }> => {
  let added = 0;
  let updated = 0;

  for (const repo of input.repos) {
    const project = existingByRepoId.get(repo.id);

    if (!project) {
      await tx.insert(projects).values({
        organizationId: input.organizationId,
        handle: repo.name.toLowerCase(),
        providerRepoId: repo.id,
        providerRepoName: repo.name,
        providerRepoFullName: repo.fullName,
        providerDefaultBranch: repo.defaultBranch ?? null,
        isPrivate: repo.isPrivate,
        createdAt: now,
        updatedAt: now,
      });
      added += 1;
      continue;
    }

    if (project.removedAt || needsProjectUpdate(project, repo)) {
      await tx
        .update(projects)
        .set({
          providerRepoName: repo.name,
          providerRepoFullName: repo.fullName,
          providerDefaultBranch: repo.defaultBranch ?? null,
          isPrivate: repo.isPrivate,
          removedAt: null,
          updatedAt: now,
        })
        .where(eq(projects.id, project.id));
      updated += 1;
    }
  }

  return { added, updated };
};

const markMissingReposRemoved = async (
  tx: TxLike,
  existing: (typeof projects.$inferSelect)[],
  incomingIds: Set<string>,
  now: Date
): Promise<number> => {
  let removed = 0;
  for (const project of existing) {
    if (project.removedAt || incomingIds.has(project.providerRepoId)) {
      continue;
    }
    await tx
      .update(projects)
      .set({ removedAt: now, updatedAt: now })
      .where(eq(projects.id, project.id));
    removed += 1;
  }
  return removed;
};

export const create = async (db: Db, input: CreateProjectInput) =>
  db.transaction(async (tx) => {
    await withProjectLock(
      tx,
      `${input.organizationId}:${input.providerRepoId}`
    );

    const [existing] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, input.organizationId),
          eq(projects.providerRepoId, input.providerRepoId)
        )
      )
      .limit(1);

    if (existing) {
      return existing.id;
    }

    const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
    const [row] = await tx
      .insert(projects)
      .values({
        organizationId: input.organizationId,
        handle: input.handle,
        providerRepoId: input.providerRepoId,
        providerRepoName: input.providerRepoName,
        providerRepoFullName: input.providerRepoFullName,
        providerDefaultBranch: input.providerDefaultBranch ?? null,
        isPrivate: input.isPrivate,
        removedAt: toDate(input.removedAt),
        createdAt,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
      })
      .returning({ id: projects.id });

    return row?.id ?? null;
  });

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return row ?? null;
};

export const getByOrgHandle = async (
  db: Db,
  organizationId: string,
  handle: string
) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.handle, handle)
      )
    )
    .limit(1);
  return row ?? null;
};

export const getByOrgRepo = async (
  db: Db,
  organizationId: string,
  providerRepoId: string
) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.providerRepoId, providerRepoId)
      )
    )
    .limit(1);
  return row ?? null;
};

export const getByRepoFullName = async (
  db: Db,
  providerRepoFullName: string
) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.providerRepoFullName, providerRepoFullName))
    .limit(1);
  return row ?? null;
};

export const getByRepoId = async (db: Db, providerRepoId: string) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.providerRepoId, providerRepoId))
    .limit(1);
  return row ?? null;
};

export const listByRepoIds = (db: Db, providerRepoIds: string[]) => {
  if (providerRepoIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(projects)
    .where(inArray(projects.providerRepoId, providerRepoIds));
};

export const listByOrg = (db: Db, options: ListByOrgOptions) => {
  const take = clampLimit(options.limit, 1, 500, 200);
  const whereClause = options.includeRemoved
    ? eq(projects.organizationId, options.organizationId)
    : and(
        eq(projects.organizationId, options.organizationId),
        isNull(projects.removedAt)
      );

  return db
    .select()
    .from(projects)
    .where(whereClause)
    .orderBy(asc(projects.createdAt))
    .limit(take);
};

export const countByOrg = async (
  db: Db,
  organizationId: string,
  includeRemoved?: boolean | null
) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(
      includeRemoved
        ? eq(projects.organizationId, organizationId)
        : and(
            eq(projects.organizationId, organizationId),
            isNull(projects.removedAt)
          )
    );
  return row?.count ?? 0;
};

export const update = async (db: Db, input: UpdateProjectInput) => {
  const [row] = await db
    .update(projects)
    .set({
      organizationId: input.organizationId,
      handle: input.handle,
      providerRepoId: input.providerRepoId,
      providerRepoName: input.providerRepoName,
      providerRepoFullName: input.providerRepoFullName,
      providerDefaultBranch: input.providerDefaultBranch,
      isPrivate: input.isPrivate,
      removedAt: toDate(input.removedAt),
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(projects.id, input.id))
    .returning({ id: projects.id });

  return row?.id ?? null;
};

export const reactivate = async (db: Db, input: ReactivateProjectInput) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.id))
    .limit(1);

  if (!project) {
    return null;
  }

  const [row] = await db
    .update(projects)
    .set({
      providerRepoName: input.providerRepoName ?? project.providerRepoName,
      providerRepoFullName:
        input.providerRepoFullName ?? project.providerRepoFullName,
      providerDefaultBranch:
        input.providerDefaultBranch ?? project.providerDefaultBranch,
      isPrivate: input.isPrivate ?? project.isPrivate,
      removedAt: null,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(projects.id, input.id))
    .returning({ id: projects.id });

  return row?.id ?? null;
};

export const syncFromGitHub = async (db: Db, input: SyncFromGitHubInput) =>
  db.transaction(async (tx) => {
    await withProjectLock(tx, `sync:${input.organizationId}`);

    const now = new Date();
    const syncRemoved = input.syncRemoved ?? true;

    const existing = await tx
      .select()
      .from(projects)
      .where(eq(projects.organizationId, input.organizationId));

    const existingByRepoId = new Map(
      existing.map((project) => [project.providerRepoId, project])
    );

    const incomingIds = new Set(input.repos.map((repo) => repo.id));

    const { added, updated } = await syncRepos(
      tx,
      input,
      existingByRepoId,
      now
    );
    const removed = syncRemoved
      ? await markMissingReposRemoved(tx, existing, incomingIds, now)
      : 0;

    return { added, updated, removed };
  });

export const clearRemovedByOrg = async (
  db: Db,
  organizationId: string,
  updatedAt?: number
) => {
  const now = updatedAt ? new Date(updatedAt) : new Date();
  const rows = await db
    .update(projects)
    .set({ removedAt: null, updatedAt: now })
    .where(
      and(
        eq(projects.organizationId, organizationId),
        sql`${projects.removedAt} is not null`
      )
    )
    .returning({ id: projects.id });
  return { updated: rows.length };
};

export const softDeleteByRepoIds = async (
  db: Db,
  input: SoftDeleteByRepoIdsInput
) => {
  if (input.providerRepoIds.length === 0) {
    return { updated: 0 };
  }

  const now = input.removedAt ? new Date(input.removedAt) : new Date();
  const rows = await db
    .update(projects)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        inArray(projects.providerRepoId, input.providerRepoIds),
        isNull(projects.removedAt)
      )
    )
    .returning({ id: projects.id });

  return { updated: rows.length };
};

export const softDeleteByOrgRepoIds = async (
  db: Db,
  input: SoftDeleteByOrgRepoIdsInput
) => {
  if (input.providerRepoIds.length === 0) {
    return { updated: 0 };
  }

  const now = input.removedAt ? new Date(input.removedAt) : new Date();
  const rows = await db
    .update(projects)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        inArray(projects.providerRepoId, input.providerRepoIds),
        isNull(projects.removedAt)
      )
    )
    .returning({ id: projects.id });

  return { updated: rows.length };
};

export const keepOnlyOrgRepoIds = async (
  db: Db,
  organizationId: string,
  providerRepoIds: string[]
) => {
  const now = new Date();

  if (providerRepoIds.length === 0) {
    const rows = await db
      .update(projects)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.removedAt)
        )
      )
      .returning({ id: projects.id });
    return { updated: rows.length };
  }

  const rows = await db
    .update(projects)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(projects.organizationId, organizationId),
        notInArray(projects.providerRepoId, providerRepoIds),
        isNull(projects.removedAt)
      )
    )
    .returning({ id: projects.id });

  return { updated: rows.length };
};
