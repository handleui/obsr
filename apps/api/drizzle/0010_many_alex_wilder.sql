ALTER TABLE "runs" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "check_run_id" varchar(64);--> statement-breakpoint
CREATE INDEX "runs_pr_number_idx" ON "runs" USING btree ("pr_number");