CREATE TABLE "user_github_identities" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workos_user_id" varchar(255) NOT NULL,
	"github_user_id" varchar(255) NOT NULL,
	"github_username" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_github_identities_workos_user_id_idx" ON "user_github_identities" USING btree ("workos_user_id");