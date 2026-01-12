DROP INDEX "runs_repository_commit_run_unique_idx";--> statement-breakpoint
DROP INDEX "runs_repository_run_id_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_repository_run_attempt_unique_idx" ON "runs" USING btree ("repository","run_id","run_attempt");--> statement-breakpoint
CREATE INDEX "runs_repository_run_id_idx" ON "runs" USING btree ("repository","run_id");