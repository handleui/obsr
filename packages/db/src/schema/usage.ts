import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export interface UsageMetadata {
  runId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  durationMinutes?: number | null;
  costUSD?: number | null;
}

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id").notNull(),
    eventName: text("event_name", { enum: ["ai", "sandbox"] }).notNull(),
    metadata: jsonb("metadata").$type<UsageMetadata>(),
    polarIngested: boolean("polar_ingested").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("usage_events_org_idx").on(table.organizationId),
    index("usage_events_org_created_idx").on(
      table.organizationId,
      table.createdAt
    ),
    index("usage_events_polar_ingested_created_idx").on(
      table.polarIngested,
      table.createdAt
    ),
  ]
);
