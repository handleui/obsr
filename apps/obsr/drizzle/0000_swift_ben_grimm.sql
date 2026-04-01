CREATE TABLE "analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_kind" text NOT NULL,
	"raw_log" text NOT NULL,
	"raw_log_was_truncated" boolean DEFAULT false NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_diagnostics" (
	"id" text PRIMARY KEY NOT NULL,
	"analysis_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"severity" text,
	"category" text,
	"source" text,
	"file_path" text,
	"line" integer,
	"column" integer,
	"rule_id" text,
	"evidence" text NOT NULL,
	"rank" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_diagnostics" ADD CONSTRAINT "analysis_diagnostics_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_created_at_idx" ON "analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "analysis_diagnostics_analysis_idx" ON "analysis_diagnostics" USING btree ("analysis_id");--> statement-breakpoint
CREATE INDEX "analysis_diagnostics_rank_idx" ON "analysis_diagnostics" USING btree ("analysis_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_diagnostics_analysis_fingerprint_uidx" ON "analysis_diagnostics" USING btree ("analysis_id","fingerprint");