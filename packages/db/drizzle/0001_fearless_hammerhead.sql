CREATE INDEX "runs_pr_number_received_idx" ON "runs" USING btree ("pr_number","received_at");--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "provider_job_id";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "workflow_step";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "workflow_action";