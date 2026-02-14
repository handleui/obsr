import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export interface LogSegment {
  start: number;
  end: number;
  signal: boolean;
}

export const runs = pgTable(
  "runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").notNull(),
    provider: text("provider", { enum: ["github", "gitlab"] }).notNull(),
    source: text("source"),
    format: text("format"),
    runId: text("run_id").notNull(),
    repository: text("repository").notNull(),
    commitSha: text("commit_sha"),
    prNumber: integer("pr_number"),
    checkRunId: text("check_run_id"),
    logBytes: integer("log_bytes"),
    logR2Key: text("log_r2_key"),
    logManifest: jsonb("log_manifest").$type<LogSegment[]>(),
    logManifestTruncated: boolean("log_manifest_truncated"),
    errorCount: integer("error_count"),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    workflowName: text("workflow_name"),
    conclusion: text("conclusion"),
    headBranch: text("head_branch"),
    runAttempt: integer("run_attempt").notNull().default(1),
    extractionStatus: text("extraction_status", {
      enum: ["success", "failed", "timeout", "skipped"],
    }),
    runStartedAt: bigint("run_started_at", { mode: "number" }),
    runCompletedAt: bigint("run_completed_at", { mode: "number" }),
  },
  (table) => [
    index("runs_project_received_idx").on(table.projectId, table.receivedAt),
    index("runs_project_pr_received_idx").on(
      table.projectId,
      table.prNumber,
      table.receivedAt
    ),
    index("runs_provider_run_idx").on(table.provider, table.runId),
    index("runs_commit_sha_idx").on(table.commitSha),
    index("runs_repo_commit_idx").on(table.repository, table.commitSha),
    index("runs_repo_run_attempt_idx").on(
      table.repository,
      table.runId,
      table.runAttempt
    ),
  ]
);
