import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const analyses = pgTable(
  "analyses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    inputKind: text("input_kind").notNull(),
    rawLog: text("raw_log").notNull(),
    rawLogWasTruncated: boolean("raw_log_was_truncated")
      .notNull()
      .default(false),
    summary: text("summary").notNull(),
  },
  (table) => [index("analyses_created_at_idx").on(table.createdAt)]
);

export const analysisDiagnostics = pgTable(
  "analysis_diagnostics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    analysisId: text("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    severity: text("severity"),
    category: text("category"),
    source: text("source"),
    filePath: text("file_path"),
    line: integer("line"),
    column: integer("column"),
    ruleId: text("rule_id"),
    evidence: text("evidence").notNull(),
    rank: integer("rank").notNull(),
  },
  (table) => [
    index("analysis_diagnostics_analysis_idx").on(table.analysisId),
    index("analysis_diagnostics_rank_idx").on(table.analysisId, table.rank),
    uniqueIndex("analysis_diagnostics_analysis_fingerprint_uidx").on(
      table.analysisId,
      table.fingerprint
    ),
  ]
);
