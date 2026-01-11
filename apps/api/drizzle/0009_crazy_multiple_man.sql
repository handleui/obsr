CREATE TABLE "run_errors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"file_path" varchar(2048),
	"line" integer,
	"column" integer,
	"message" text NOT NULL,
	"category" varchar(32),
	"severity" varchar(16),
	"rule_id" varchar(255),
	"source" varchar(64),
	"stack_trace" text,
	"suggestions" jsonb,
	"hint" text,
	"workflow_job" varchar(255),
	"workflow_step" varchar(255),
	"workflow_action" varchar(255),
	"unknown_pattern" boolean,
	"line_known" boolean,
	"column_known" boolean,
	"message_truncated" boolean,
	"stack_trace_truncated" boolean,
	"code_snippet" jsonb,
	"exit_code" integer,
	"is_infrastructure" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_errors" ADD CONSTRAINT "run_errors_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_errors_run_id_idx" ON "run_errors" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_errors_category_idx" ON "run_errors" USING btree ("category");--> statement-breakpoint
CREATE INDEX "run_errors_source_idx" ON "run_errors" USING btree ("source");--> statement-breakpoint
CREATE INDEX "run_errors_rule_id_idx" ON "run_errors" USING btree ("rule_id");