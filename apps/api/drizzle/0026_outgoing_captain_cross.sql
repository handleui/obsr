CREATE TYPE "public"."job_conclusion" AS ENUM('success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'waiting', 'in_progress', 'completed');--> statement-breakpoint
CREATE TABLE "commit_job_stats" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"repository" varchar(500) NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"pr_number" integer,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"failed_jobs" integer DEFAULT 0 NOT NULL,
	"detent_jobs" integer DEFAULT 0 NOT NULL,
	"total_errors" integer DEFAULT 0 NOT NULL,
	"comment_posted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider_job_id" varchar(64) NOT NULL,
	"run_id" varchar(36),
	"repository" varchar(500) NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"pr_number" integer,
	"name" varchar(255) NOT NULL,
	"workflow_name" varchar(255),
	"status" "job_status" NOT NULL,
	"conclusion" "job_conclusion",
	"has_detent" boolean DEFAULT false NOT NULL,
	"error_count" integer DEFAULT 0,
	"html_url" varchar(500),
	"runner_name" varchar(255),
	"head_branch" varchar(255),
	"queued_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commit_job_stats_repo_commit_idx" ON "commit_job_stats" USING btree ("repository","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_repo_provider_job_id_idx" ON "jobs" USING btree ("repository","provider_job_id");--> statement-breakpoint
CREATE INDEX "jobs_repo_commit_sha_idx" ON "jobs" USING btree ("repository","commit_sha");--> statement-breakpoint
CREATE INDEX "jobs_run_id_idx" ON "jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");