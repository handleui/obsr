CREATE TABLE "runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"project_id" varchar(36),
	"provider" "provider",
	"source" varchar(32),
	"format" varchar(32),
	"run_id" varchar(255),
	"repository" varchar(500),
	"commit_sha" varchar(64),
	"log_bytes" integer,
	"error_count" integer,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_project_id_idx" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runs_provider_run_id_idx" ON "runs" USING btree ("provider","run_id");--> statement-breakpoint
CREATE INDEX "runs_commit_sha_idx" ON "runs" USING btree ("commit_sha");