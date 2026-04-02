CREATE TABLE "issue_diagnostics" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"repo_fingerprint" text NOT NULL,
	"lore_fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"severity" text,
	"category" text,
	"source" text,
	"file_path" text,
	"line" integer,
	"column" integer,
	"rule_id" text,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"raw_text" text,
	"raw_payload" jsonb,
	"context" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"was_redacted" boolean DEFAULT false NOT NULL,
	"was_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"primary_category" text,
	"primary_source_kind" text,
	"source_kinds" jsonb NOT NULL,
	"summary" text NOT NULL,
	"root_cause" text,
	"plan" jsonb NOT NULL,
	"cluster_key" text NOT NULL,
	"repo" text,
	"app" text,
	"service" text,
	"environment" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"diagnostic_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_diagnostics" ADD CONSTRAINT "issue_diagnostics_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_diagnostics" ADD CONSTRAINT "issue_diagnostics_observation_id_issue_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."issue_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_diagnostics_issue_idx" ON "issue_diagnostics" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_diagnostics_observation_idx" ON "issue_diagnostics" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "issue_diagnostics_repo_fp_idx" ON "issue_diagnostics" USING btree ("repo_fingerprint");--> statement-breakpoint
CREATE INDEX "issue_diagnostics_lore_fp_idx" ON "issue_diagnostics" USING btree ("lore_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_diagnostics_observation_fingerprint_uidx" ON "issue_diagnostics" USING btree ("observation_id","fingerprint");--> statement-breakpoint
CREATE INDEX "issue_observations_issue_idx" ON "issue_observations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_observations_captured_at_idx" ON "issue_observations" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "issues_created_at_idx" ON "issues" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "issues_last_seen_at_idx" ON "issues" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "issues_cluster_key_idx" ON "issues" USING btree ("cluster_key");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");