import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { usageEvents } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.id, id))
    .limit(1);
  return row ?? null;
};

export const listByOrg = async (
  db: Db,
  organizationId: string,
  limit?: number | null
) =>
  db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.organizationId, organizationId))
    .orderBy(desc(usageEvents.createdAt))
    .limit(clampLimit(limit, 1, 1000, 200));

export const listByOrgSince = async (
  db: Db,
  organizationId: string,
  since: number,
  limit?: number | null
) =>
  db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.organizationId, organizationId),
        gte(usageEvents.createdAt, since)
      )
    )
    .orderBy(desc(usageEvents.createdAt))
    .limit(clampLimit(limit, 1, 5000, 500));

export const listByPolarIngested = async (
  db: Db,
  polarIngested: boolean,
  limit?: number | null
) =>
  db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.polarIngested, polarIngested))
    .orderBy(asc(usageEvents.createdAt))
    .limit(clampLimit(limit, 1, 1000, 200));

export const create = async (db: Db, data: typeof usageEvents.$inferInsert) => {
  const [row] = await db.insert(usageEvents).values(data).returning();
  return row as NonNullable<typeof row>;
};

export const update = async (
  db: Db,
  id: string,
  data: Partial<
    Pick<typeof usageEvents.$inferInsert, "metadata" | "polarIngested">
  >
) => {
  const [row] = await db
    .update(usageEvents)
    .set(data)
    .where(eq(usageEvents.id, id))
    .returning();
  return row ?? null;
};

export const markPolarIngestedBatch = async (
  db: Db,
  ids: string[]
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  await db
    .update(usageEvents)
    .set({ polarIngested: true })
    .where(inArray(usageEvents.id, ids));
};

export interface CostBreakdown {
  totalCost: number;
  aiCost: number;
  sandboxCost: number;
  eventCount: number;
}

export const aggregateCostByOrg = async (
  db: Db,
  organizationId: string
): Promise<CostBreakdown> => {
  const rows = await db
    .select({
      eventName: usageEvents.eventName,
      totalCost:
        sql<string>`COALESCE(SUM((${usageEvents.metadata}->>'costUSD')::numeric), 0)`.as(
          "total_cost"
        ),
      cnt: sql<string>`COUNT(*)`.as("cnt"),
    })
    .from(usageEvents)
    .where(eq(usageEvents.organizationId, organizationId))
    .groupBy(usageEvents.eventName);

  let totalCost = 0;
  let aiCost = 0;
  let sandboxCost = 0;
  let eventCount = 0;

  for (const row of rows) {
    const cost = Number(row.totalCost) || 0;
    const count = Number(row.cnt) || 0;
    totalCost += cost;
    eventCount += count;
    if (row.eventName === "ai") {
      aiCost = cost;
    } else if (row.eventName === "sandbox") {
      sandboxCost = cost;
    }
  }

  return { totalCost, aiCost, sandboxCost, eventCount };
};
