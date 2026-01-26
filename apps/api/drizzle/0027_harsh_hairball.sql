ALTER TYPE "public"."job_conclusion" ADD VALUE 'stale';--> statement-breakpoint
ALTER TYPE "public"."job_conclusion" ADD VALUE 'startup_failure';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'pending';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'requested';--> statement-breakpoint
DROP INDEX "jobs_status_idx";--> statement-breakpoint
CREATE INDEX "jobs_repo_commit_name_idx" ON "jobs" USING btree ("repository","commit_sha","name");