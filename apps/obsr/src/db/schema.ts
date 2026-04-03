import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IssueObservationContext, IssuePlan } from "@/lib/issues/schema";
import { user } from "./auth-schema";

export const issues = pgTable(
  "issues",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    severity: text("severity").notNull(),
    status: text("status").notNull(),
    primaryCategory: text("primary_category"),
    primarySourceKind: text("primary_source_kind"),
    sourceKinds: jsonb("source_kinds").$type<string[]>().notNull(),
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    plan: jsonb("plan").$type<IssuePlan>().notNull(),
    clusterKey: text("cluster_key").notNull(),
    repo: text("repo"),
    app: text("app"),
    service: text("service"),
    environment: text("environment").notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    observationCount: integer("observation_count").notNull().default(0),
    diagnosticCount: integer("diagnostic_count").notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("issues_created_at_idx").on(table.createdAt),
    index("issues_owner_last_seen_idx").on(table.ownerUserId, table.lastSeenAt),
    index("issues_owner_cluster_key_idx").on(
      table.ownerUserId,
      table.clusterKey
    ),
  ]
);

export const issueObservations = pgTable(
  "issue_observations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    sourceKind: text("source_kind").notNull(),
    rawText: text("raw_text"),
    rawPayload: jsonb("raw_payload").$type<unknown>(),
    dedupeKey: text("dedupe_key"),
    context: jsonb("context").$type<IssueObservationContext>().notNull(),
    capturedAt: timestamp("captured_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    wasRedacted: boolean("was_redacted").notNull().default(false),
    wasTruncated: boolean("was_truncated").notNull().default(false),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("issue_observations_issue_idx").on(table.issueId),
    index("issue_observations_owner_idx").on(table.ownerUserId),
    index("issue_observations_captured_at_idx").on(table.capturedAt),
    uniqueIndex("issue_observations_owner_dedupe_key_uidx").on(
      table.ownerUserId,
      table.dedupeKey
    ),
  ]
);

export const vercelConnections = pgTable(
  "vercel_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("vercel_connections_owner_uidx").on(table.ownerUserId),
  ]
);

export const vercelSyncTargets = pgTable(
  "vercel_sync_targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    teamId: text("team_id").notNull(),
    teamSlug: text("team_slug"),
    projectId: text("project_id").notNull(),
    projectName: text("project_name"),
    repo: text("repo"),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastDeploymentCreatedAt: timestamp("last_deployment_created_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("vercel_sync_targets_owner_idx").on(table.ownerUserId),
    uniqueIndex("vercel_sync_targets_owner_team_project_uidx").on(
      table.ownerUserId,
      table.teamId,
      table.projectId
    ),
  ]
);

export const issueDiagnostics = pgTable(
  "issue_diagnostics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    observationId: text("observation_id")
      .notNull()
      .references(() => issueObservations.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    repoFingerprint: text("repo_fingerprint").notNull(),
    loreFingerprint: text("lore_fingerprint").notNull(),
    message: text("message").notNull(),
    severity: text("severity"),
    category: text("category"),
    source: text("source"),
    filePath: text("file_path"),
    line: integer("line"),
    column: integer("column"),
    ruleId: text("rule_id"),
    evidence: text("evidence").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("issue_diagnostics_issue_idx").on(table.issueId),
    index("issue_diagnostics_observation_idx").on(table.observationId),
    index("issue_diagnostics_repo_fp_idx").on(table.repoFingerprint),
    index("issue_diagnostics_lore_fp_idx").on(table.loreFingerprint),
    uniqueIndex("issue_diagnostics_observation_fingerprint_uidx").on(
      table.observationId,
      table.fingerprint
    ),
  ]
);
