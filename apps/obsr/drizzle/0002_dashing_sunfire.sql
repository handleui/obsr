CREATE TABLE "vercel_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vercel_sync_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_slug" text,
	"project_id" text NOT NULL,
	"project_name" text,
	"repo" text,
	"last_synced_at" timestamp with time zone,
	"last_deployment_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_observations" ADD COLUMN "owner_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_observations" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "vercel_connections" ADD CONSTRAINT "vercel_connections_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vercel_sync_targets" ADD CONSTRAINT "vercel_sync_targets_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vercel_connections_owner_uidx" ON "vercel_connections" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "vercel_sync_targets_owner_idx" ON "vercel_sync_targets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vercel_sync_targets_owner_team_project_uidx" ON "vercel_sync_targets" USING btree ("owner_user_id","team_id","project_id");--> statement-breakpoint
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_observations_owner_idx" ON "issue_observations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_observations_owner_dedupe_key_uidx" ON "issue_observations" USING btree ("owner_user_id","dedupe_key");