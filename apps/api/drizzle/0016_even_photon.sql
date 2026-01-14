CREATE TABLE "user_identities" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workos_user_id" varchar(255) NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_user_id" varchar(255) NOT NULL,
	"provider_username" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_workos_provider_idx" ON "user_identities" USING btree ("workos_user_id","provider");