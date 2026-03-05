import { and, eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { webhooks } from "../schema/index.js";
import { clampLimit } from "../utils.js";

type WebhookEvent =
  | "resolve.pending"
  | "resolve.running"
  | "resolve.completed"
  | "resolve.applied"
  | "resolve.rejected"
  | "resolve.failed";

interface CreateWebhookInput {
  organizationId: string;
  url: string;
  name: string;
  events: WebhookEvent[];
  secretEncrypted: string;
  secretPrefix: string;
  active?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface UpdateWebhookInput {
  id: string;
  url?: string;
  name?: string;
  events?: WebhookEvent[];
  active?: boolean;
  updatedAt?: number;
}

export const create = async (db: Db, input: CreateWebhookInput) => {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  const [row] = await db
    .insert(webhooks)
    .values({
      organizationId: input.organizationId,
      url: input.url,
      name: input.name,
      events: input.events,
      secretEncrypted: input.secretEncrypted,
      secretPrefix: input.secretPrefix,
      active: input.active ?? true,
      createdAt,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
    })
    .returning({ id: webhooks.id });
  return row?.id ?? null;
};

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, id))
    .limit(1);
  return row ?? null;
};

export const listByOrg = (
  db: Db,
  organizationId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 50, 50);
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.organizationId, organizationId))
    .limit(take);
};

export const listActiveByOrg = (
  db: Db,
  organizationId: string,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 50, 50);
  return db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.organizationId, organizationId),
        eq(webhooks.active, true)
      )
    )
    .limit(take);
};

export const update = async (db: Db, input: UpdateWebhookInput) => {
  const [row] = await db
    .update(webhooks)
    .set({
      url: input.url,
      name: input.name,
      events: input.events,
      active: input.active,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(webhooks.id, input.id))
    .returning({ id: webhooks.id });
  return row?.id ?? null;
};

export const remove = async (db: Db, id: string) => {
  const [row] = await db
    .delete(webhooks)
    .where(eq(webhooks.id, id))
    .returning({ id: webhooks.id });
  return row?.id ?? null;
};
