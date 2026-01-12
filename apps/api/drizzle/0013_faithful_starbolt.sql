CREATE TABLE "pr_comments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"repository" varchar(500) NOT NULL,
	"pr_number" integer NOT NULL,
	"comment_id" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_comments_repo_pr_unique_idx" ON "pr_comments" USING btree ("repository","pr_number");--> statement-breakpoint
CREATE INDEX "pr_comments_repository_idx" ON "pr_comments" USING btree ("repository");