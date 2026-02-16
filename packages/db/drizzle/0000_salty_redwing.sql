CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"source" text,
	"format" text,
	"run_id" text NOT NULL,
	"repository" text NOT NULL,
	"commit_sha" text,
	"pr_number" integer,
	"check_run_id" text,
	"log_bytes" integer,
	"log_r2_key" text,
	"log_manifest" jsonb,
	"log_manifest_truncated" boolean,
	"error_count" integer,
	"received_at" bigint NOT NULL,
	"workflow_name" text,
	"conclusion" text,
	"head_branch" text,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"extraction_status" text,
	"run_started_at" bigint,
	"run_completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "error_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"signature_id" text NOT NULL,
	"project_id" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"run_count" integer DEFAULT 1 NOT NULL,
	"first_seen_commit" text,
	"first_seen_at" bigint NOT NULL,
	"last_seen_commit" text,
	"last_seen_at" bigint NOT NULL,
	"fixed_at" bigint,
	"fixed_by_commit" text,
	"fix_verified" boolean,
	"common_files" jsonb,
	CONSTRAINT "error_occurrences_signature_project_uniq" UNIQUE("signature_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "error_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text,
	"rule_id" text,
	"category" text,
	"normalized_pattern" text,
	"example_message" text,
	"lore_candidate" boolean,
	"lore_synced_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "error_signatures_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "run_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"file_path" text,
	"line" integer,
	"column" integer,
	"message" text NOT NULL,
	"category" text,
	"severity" text,
	"rule_id" text,
	"source" text,
	"stack_trace" text,
	"hints" jsonb,
	"provider_job_id" text,
	"workflow_job" text,
	"workflow_step" text,
	"workflow_action" text,
	"code_snippet" jsonb,
	"related_files" jsonb,
	"fixable" boolean,
	"log_line_start" integer,
	"log_line_end" integer,
	"signature_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_name" text NOT NULL,
	"metadata" jsonb,
	"polar_ingested" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runs_project_received_idx" ON "runs" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "runs_project_pr_received_idx" ON "runs" USING btree ("project_id","pr_number","received_at");--> statement-breakpoint
CREATE INDEX "runs_provider_run_idx" ON "runs" USING btree ("provider","run_id");--> statement-breakpoint
CREATE INDEX "runs_commit_sha_idx" ON "runs" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "runs_repo_commit_idx" ON "runs" USING btree ("repository","commit_sha");--> statement-breakpoint
CREATE INDEX "runs_repo_run_attempt_idx" ON "runs" USING btree ("repository","run_id","run_attempt");--> statement-breakpoint
CREATE INDEX "error_occurrences_project_idx" ON "error_occurrences" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "error_occurrences_last_seen_idx" ON "error_occurrences" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "error_signatures_source_rule_idx" ON "error_signatures" USING btree ("source","rule_id");--> statement-breakpoint
CREATE INDEX "run_errors_run_id_idx" ON "run_errors" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_errors_signature_idx" ON "run_errors" USING btree ("signature_id");--> statement-breakpoint
CREATE INDEX "run_errors_run_id_source_idx" ON "run_errors" USING btree ("run_id","source");--> statement-breakpoint
CREATE INDEX "usage_events_org_idx" ON "usage_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_events_org_created_idx" ON "usage_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_polar_ingested_created_idx" ON "usage_events" USING btree ("polar_ingested","created_at");