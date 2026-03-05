import { and, eq, isNull, lt, or } from "drizzle-orm";

import type { Db } from "../client.js";
import { apiKeys } from "../schema/index.js";
import { clampLimit } from "../utils.js";

interface CreateApiKeyInput {
  organizationId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  createdAt?: number;
  lastUsedAt?: number | null;
}

interface UpdateApiKeyInput {
  id: string;
  name?: string;
  lastUsedAt?: number | null;
}

export const create = async (db: Db, input: CreateApiKeyInput) => {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();

  const [inserted] = await db
    .insert(apiKeys)
    .values({
      organizationId: input.organizationId,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      name: input.name,
      createdAt,
      lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null,
      updatedAt: createdAt,
    })
    .onConflictDoNothing({ target: [apiKeys.keyHash] })
    .returning({ id: apiKeys.id });

  if (inserted?.id) {
    return inserted.id;
  }

  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, input.keyHash))
    .limit(1);

  return existing?.id ?? null;
};

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return row ?? null;
};

export const getByKeyHash = async (db: Db, keyHash: string) => {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  return row ?? null;
};

export const listByOrg = (
  db: Db,
  organizationId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 200, 100);
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, organizationId))
    .limit(take);
};

export const updateLastUsedAt = async (
  db: Db,
  id: string,
  lastUsedAt: number
) => {
  const timestamp = new Date(lastUsedAt);
  const [updated] = await db
    .update(apiKeys)
    .set({ lastUsedAt: timestamp, updatedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, timestamp))
      )
    )
    .returning({ id: apiKeys.id });

  if (updated?.id) {
    return updated.id;
  }

  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);

  return existing?.id ?? null;
};

export const update = async (db: Db, input: UpdateApiKeyInput) => {
  let lastUsedAtValue: Date | null | undefined;
  if (input.lastUsedAt === undefined) {
    lastUsedAtValue = undefined;
  } else if (input.lastUsedAt === null) {
    lastUsedAtValue = null;
  } else {
    lastUsedAtValue = new Date(input.lastUsedAt);
  }

  const [row] = await db
    .update(apiKeys)
    .set({
      name: input.name,
      lastUsedAt: lastUsedAtValue,
      updatedAt: new Date(),
    })
    .where(eq(apiKeys.id, input.id))
    .returning({ id: apiKeys.id });

  return row?.id ?? null;
};

export const remove = async (db: Db, id: string) => {
  const [row] = await db
    .delete(apiKeys)
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id });
  return row?.id ?? null;
};
