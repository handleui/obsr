import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

export interface CodeSnippet {
  lines: string[];
  startLine: number;
  errorLine: number;
  language: string;
}

export const runErrors = pgTable(
  "run_errors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id").notNull(),
    filePath: text("file_path"),
    line: integer("line"),
    column: integer("column"),
    message: text("message").notNull(),
    category: text("category"),
    severity: text("severity"),
    ruleId: text("rule_id"),
    source: text("source"),
    stackTrace: text("stack_trace"),
    hints: jsonb("hints").$type<string[]>(),
    workflowJob: text("workflow_job"),
    codeSnippet: jsonb("code_snippet").$type<CodeSnippet | null>(),
    relatedFiles: jsonb("related_files").$type<string[]>(),
    fixable: boolean("fixable"),
    logLineStart: integer("log_line_start"),
    logLineEnd: integer("log_line_end"),
    signatureId: text("signature_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("run_errors_run_id_idx").on(table.runId),
    index("run_errors_signature_idx").on(table.signatureId),
    index("run_errors_run_id_source_idx").on(table.runId, table.source),
  ]
);

export const errorSignatures = pgTable(
  "error_signatures",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fingerprint: text("fingerprint").notNull().unique(),
    source: text("source"),
    ruleId: text("rule_id"),
    category: text("category"),
    normalizedPattern: text("normalized_pattern"),
    exampleMessage: text("example_message"),
    loreCandidate: boolean("lore_candidate"),
    loreSyncedAt: bigint("lore_synced_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("error_signatures_source_rule_idx").on(table.source, table.ruleId),
  ]
);

export const errorOccurrences = pgTable(
  "error_occurrences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    signatureId: text("signature_id").notNull(),
    projectId: text("project_id").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    runCount: integer("run_count").notNull().default(1),
    firstSeenCommit: text("first_seen_commit"),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastSeenCommit: text("last_seen_commit"),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    fixedAt: bigint("fixed_at", { mode: "number" }),
    fixedByCommit: text("fixed_by_commit"),
    fixVerified: boolean("fix_verified"),
    commonFiles: jsonb("common_files").$type<string[]>(),
  },
  (table) => [
    index("error_occurrences_project_idx").on(table.projectId),
    index("error_occurrences_last_seen_idx").on(table.lastSeenAt),
    unique("error_occurrences_signature_project_uniq").on(
      table.signatureId,
      table.projectId
    ),
  ]
);
