ALTER TABLE "runs" ADD COLUMN "workflow_name" varchar(255);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conclusion" varchar(32);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "head_branch" varchar(255);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_attempt" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_completed_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_repository_run_id_unique_idx" ON "runs" USING btree ("repository","run_id");--> statement-breakpoint
CREATE INDEX "runs_workflow_name_idx" ON "runs" USING btree ("workflow_name");--> statement-breakpoint
CREATE INDEX "runs_conclusion_idx" ON "runs" USING btree ("conclusion");