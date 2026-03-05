import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { organizations } from "../schema/index.js";
import { clampLimit } from "../utils.js";

interface CreateOrganizationInput {
  name: string;
  slug: string;
  enterpriseId?: string | null;
  provider: "github" | "gitlab";
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerAvatarUrl?: string | null;
  providerInstallationId?: string | null;
  providerAccessTokenEncrypted?: string | null;
  providerAccessTokenExpiresAt?: number | null;
  providerWebhookSecret?: string | null;
  installerGithubId?: string | null;
  suspendedAt?: number | null;
  deletedAt?: number | null;
  lastSyncedAt?: number | null;
  settings?: typeof organizations.$inferInsert.settings;
  polarCustomerId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface UpdateOrganizationInput {
  id: string;
  name?: string;
  slug?: string;
  enterpriseId?: string | null;
  provider?: "github" | "gitlab";
  providerAccountId?: string;
  providerAccountLogin?: string;
  providerAccountType?: "organization" | "user";
  providerAvatarUrl?: string | null;
  providerInstallationId?: string | null;
  providerAccessTokenEncrypted?: string | null;
  providerAccessTokenExpiresAt?: number | null;
  providerWebhookSecret?: string | null;
  installerGithubId?: string | null;
  suspendedAt?: number | null;
  deletedAt?: number | null;
  lastSyncedAt?: number | null;
  settings?: typeof organizations.$inferInsert.settings;
  polarCustomerId?: string | null;
  updatedAt?: number;
}

interface ListByProviderAccountIdsInput {
  provider: "github" | "gitlab";
  providerAccountIds: string[];
  includeDeleted?: boolean | null;
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

export const create = async (db: Db, input: CreateOrganizationInput) => {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  const [row] = await db
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug,
      enterpriseId: input.enterpriseId ?? null,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerAccountLogin: input.providerAccountLogin,
      providerAccountType: input.providerAccountType,
      providerAvatarUrl: input.providerAvatarUrl ?? null,
      providerInstallationId: input.providerInstallationId ?? null,
      providerAccessTokenEncrypted: input.providerAccessTokenEncrypted ?? null,
      providerAccessTokenExpiresAt: toDate(input.providerAccessTokenExpiresAt),
      providerWebhookSecret: input.providerWebhookSecret ?? null,
      installerGithubId: input.installerGithubId ?? null,
      suspendedAt: toDate(input.suspendedAt),
      deletedAt: toDate(input.deletedAt),
      lastSyncedAt: toDate(input.lastSyncedAt),
      settings: input.settings,
      polarCustomerId: input.polarCustomerId ?? null,
      createdAt,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
    })
    .returning({ id: organizations.id });
  return row?.id ?? null;
};

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return row ?? null;
};

export const getBySlug = async (db: Db, slug: string) => {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return row ?? null;
};

export const getByProviderAccount = async (
  db: Db,
  provider: "github" | "gitlab",
  providerAccountId: string
) => {
  const [row] = await db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, provider),
        eq(organizations.providerAccountId, providerAccountId)
      )
    )
    .limit(1);
  return row ?? null;
};

export const getByProviderAccountLogin = async (
  db: Db,
  provider: "github" | "gitlab",
  providerAccountLogin: string
) => {
  const [row] = await db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, provider),
        eq(organizations.providerAccountLogin, providerAccountLogin)
      )
    )
    .limit(1);
  return row ?? null;
};

export const listByProviderAccountIds = async (
  db: Db,
  input: ListByProviderAccountIdsInput
) => {
  if (input.providerAccountIds.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, input.provider),
        inArray(organizations.providerAccountId, input.providerAccountIds)
      )
    );

  return input.includeDeleted
    ? rows
    : rows.filter((row) => row.deletedAt === null);
};

export const listByInstallerGithubId = (
  db: Db,
  installerGithubId: string
): Promise<(typeof organizations.$inferSelect)[]> =>
  db
    .select()
    .from(organizations)
    .where(eq(organizations.installerGithubId, installerGithubId))
    .limit(100);

export const listByEnterprise = (
  db: Db,
  enterpriseId: string
): Promise<(typeof organizations.$inferSelect)[]> =>
  db
    .select()
    .from(organizations)
    .where(eq(organizations.enterpriseId, enterpriseId))
    .limit(500);

export const listByProviderInstallationId = (
  db: Db,
  providerInstallationId: string
): Promise<(typeof organizations.$inferSelect)[]> =>
  db
    .select()
    .from(organizations)
    .where(eq(organizations.providerInstallationId, providerInstallationId))
    .limit(10);

export const list = (db: Db, limit?: number | null) => {
  const take = clampLimit(limit, 1, 200, 50);
  return db.select().from(organizations).limit(take);
};

export const listActiveGithub = (db: Db, limit?: number | null) => {
  const take = clampLimit(limit, 1, 5000, 500);
  return db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, "github"),
        isNull(organizations.deletedAt),
        isNull(organizations.suspendedAt),
        sql`${organizations.providerInstallationId} is not null`
      )
    )
    .orderBy(asc(organizations.lastSyncedAt), desc(organizations.createdAt))
    .limit(take);
};

export const update = async (db: Db, input: UpdateOrganizationInput) => {
  const [row] = await db
    .update(organizations)
    .set({
      name: input.name,
      slug: input.slug,
      enterpriseId: input.enterpriseId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerAccountLogin: input.providerAccountLogin,
      providerAccountType: input.providerAccountType,
      providerAvatarUrl: input.providerAvatarUrl,
      providerInstallationId: input.providerInstallationId,
      providerAccessTokenEncrypted: input.providerAccessTokenEncrypted,
      providerAccessTokenExpiresAt: toDate(input.providerAccessTokenExpiresAt),
      providerWebhookSecret: input.providerWebhookSecret,
      installerGithubId: input.installerGithubId,
      suspendedAt: toDate(input.suspendedAt),
      deletedAt: toDate(input.deletedAt),
      lastSyncedAt: toDate(input.lastSyncedAt),
      settings: input.settings,
      polarCustomerId: input.polarCustomerId,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(organizations.id, input.id))
    .returning({ id: organizations.id });

  return row?.id ?? null;
};
