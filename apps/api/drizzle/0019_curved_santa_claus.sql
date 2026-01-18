CREATE TABLE "error_occurrences" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"signature_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"run_count" integer DEFAULT 1 NOT NULL,
	"first_seen_commit" varchar(40),
	"first_seen_at" timestamp NOT NULL,
	"last_seen_commit" varchar(40),
	"last_seen_at" timestamp NOT NULL,
	"fixed_at" timestamp,
	"fixed_by_commit" varchar(40),
	"fix_verified" boolean DEFAULT false,
	"common_files" jsonb
);
--> statement-breakpoint
CREATE TABLE "error_signatures" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"fingerprint" varchar(32) NOT NULL,
	"source" varchar(64),
	"rule_id" varchar(255),
	"category" varchar(32),
	"normalized_pattern" text,
	"example_message" text,
	"lore_candidate" boolean DEFAULT true,
	"lore_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "error_signatures_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "run_errors" ADD COLUMN "fixable" boolean;--> statement-breakpoint
ALTER TABLE "run_errors" ADD COLUMN "signature_id" varchar(36);--> statement-breakpoint
ALTER TABLE "error_occurrences" ADD CONSTRAINT "error_occurrences_signature_id_error_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."error_signatures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_occurrences" ADD CONSTRAINT "error_occurrences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_occurrences_project_idx" ON "error_occurrences" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "error_occurrences_last_seen_idx" ON "error_occurrences" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "error_occurrences_sig_proj_idx" ON "error_occurrences" USING btree ("signature_id","project_id");--> statement-breakpoint
CREATE INDEX "error_signatures_source_rule_idx" ON "error_signatures" USING btree ("source","rule_id");--> statement-breakpoint
ALTER TABLE "run_errors" ADD CONSTRAINT "run_errors_signature_id_error_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."error_signatures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_errors_signature_idx" ON "run_errors" USING btree ("signature_id");