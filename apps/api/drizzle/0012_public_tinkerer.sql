CREATE TABLE "pr_comments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"repository" varchar(500) NOT NULL,
	"pr_number" integer NOT NULL,
	"comment_id" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "runs_repository_commit_run_unique_idx";--> statement-breakpoint
ALTER TABLE "run_errors" ADD COLUMN "possibly_test_output" boolean;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_name" varchar(255);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conclusion" varchar(32);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "head_branch" varchar(255);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_attempt" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_completed_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_comments_repo_pr_unique_idx" ON "pr_comments" USING btree ("repository","pr_number");--> statement-breakpoint
CREATE INDEX "pr_comments_repository_idx" ON "pr_comments" USING btree ("repository");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_repository_run_attempt_unique_idx" ON "runs" USING btree ("repository","run_id","run_attempt");--> statement-breakpoint
CREATE INDEX "runs_workflow_name_idx" ON "runs" USING btree ("workflow_name");