CREATE TYPE "public"."heal_status" AS ENUM('pending', 'running', 'completed', 'applied', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."heal_type" AS ENUM('autofix', 'heal');--> statement-breakpoint
CREATE TABLE "heals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"type" "heal_type" NOT NULL,
	"status" "heal_status" DEFAULT 'pending' NOT NULL,
	"run_id" varchar(36),
	"project_id" varchar(36) NOT NULL,
	"commit_sha" varchar(64),
	"pr_number" integer,
	"error_ids" jsonb,
	"signature_ids" jsonb,
	"patch" text,
	"commit_message" varchar(500),
	"files_changed" jsonb,
	"autofix_source" varchar(64),
	"autofix_command" varchar(500),
	"heal_result" jsonb,
	"cost_usd" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"applied_at" timestamp,
	"applied_commit_sha" varchar(64),
	"rejected_at" timestamp,
	"rejected_by" varchar(255),
	"rejection_reason" text,
	"failed_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heals" ADD CONSTRAINT "heals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heals" ADD CONSTRAINT "heals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heals_run_id_idx" ON "heals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "heals_project_id_idx" ON "heals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "heals_pr_number_idx" ON "heals" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX "heals_status_idx" ON "heals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "heals_project_status_idx" ON "heals" USING btree ("project_id","status");