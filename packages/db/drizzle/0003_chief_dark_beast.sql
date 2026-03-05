CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commit_job_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"commit_sha" text NOT NULL,
	"pr_number" integer,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"failed_jobs" integer DEFAULT 0 NOT NULL,
	"detent_jobs" integer DEFAULT 0 NOT NULL,
	"total_errors" integer DEFAULT 0 NOT NULL,
	"comment_posted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_job_id" text NOT NULL,
	"run_id" text,
	"repository" text NOT NULL,
	"commit_sha" text NOT NULL,
	"pr_number" integer,
	"name" text NOT NULL,
	"workflow_name" text,
	"status" text NOT NULL,
	"conclusion" text,
	"has_detent" boolean DEFAULT false NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"html_url" text,
	"runner_name" text,
	"head_branch" text,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"provider_user_id" text,
	"provider_username" text,
	"provider_linked_at" timestamp with time zone,
	"provider_verified_at" timestamp with time zone,
	"membership_source" text,
	"removed_at" timestamp with time zone,
	"removal_reason" text,
	"removed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"enterprise_id" text,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_account_login" text NOT NULL,
	"provider_account_type" text NOT NULL,
	"provider_avatar_url" text,
	"provider_installation_id" text,
	"provider_access_token_encrypted" text,
	"provider_access_token_expires_at" timestamp with time zone,
	"provider_webhook_secret" text,
	"installer_github_id" text,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"settings" jsonb,
	"polar_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"comment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"handle" text NOT NULL,
	"provider_repo_id" text NOT NULL,
	"provider_repo_name" text NOT NULL,
	"provider_repo_full_name" text NOT NULL,
	"provider_default_branch" text,
	"is_private" boolean NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolves" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"project_id" text NOT NULL,
	"commit_sha" text,
	"pr_number" integer,
	"check_run_id" text,
	"error_ids" text[],
	"signature_ids" text[],
	"patch" text,
	"commit_message" text,
	"files_changed" text[],
	"files_changed_with_content" jsonb,
	"autofix_source" text,
	"autofix_command" text,
	"user_instructions" text,
	"resolve_result" jsonb,
	"cost_usd" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"applied_at" timestamp with time zone,
	"applied_commit_sha" text,
	"rejected_at" timestamp with time zone,
	"rejected_by" text,
	"rejection_reason" text,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"events" text[] NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_prefix" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolves" ADD CONSTRAINT "resolves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uidx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "commit_job_stats_repo_commit_idx" ON "commit_job_stats" USING btree ("repository","commit_sha");--> statement-breakpoint
CREATE INDEX "commit_job_stats_repo_idx" ON "commit_job_stats" USING btree ("repository");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_uidx" ON "invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "invitations_org_status_idx" ON "invitations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "jobs_repo_job_idx" ON "jobs" USING btree ("repository","provider_job_id");--> statement-breakpoint
CREATE INDEX "jobs_repo_commit_idx" ON "jobs" USING btree ("repository","commit_sha");--> statement-breakpoint
CREATE INDEX "jobs_repo_commit_name_idx" ON "jobs" USING btree ("repository","commit_sha","name");--> statement-breakpoint
CREATE INDEX "jobs_run_id_idx" ON "jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "organization_members_org_user_idx" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_id_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_members_provider_user_id_idx" ON "organization_members" USING btree ("provider_user_id");--> statement-breakpoint
CREATE INDEX "organization_members_org_role_idx" ON "organization_members" USING btree ("organization_id","role");--> statement-breakpoint
CREATE INDEX "organization_members_removed_at_idx" ON "organization_members" USING btree ("removed_at");--> statement-breakpoint
CREATE INDEX "organization_members_org_provider_user_idx" ON "organization_members" USING btree ("organization_id","provider_user_id");--> statement-breakpoint
CREATE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_provider_account_idx" ON "organizations" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "organizations_provider_account_login_idx" ON "organizations" USING btree ("provider","provider_account_login");--> statement-breakpoint
CREATE INDEX "organizations_provider_installation_idx" ON "organizations" USING btree ("provider_installation_id");--> statement-breakpoint
CREATE INDEX "organizations_installer_github_idx" ON "organizations" USING btree ("installer_github_id");--> statement-breakpoint
CREATE INDEX "organizations_enterprise_idx" ON "organizations" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "pr_comments_repo_pr_idx" ON "pr_comments" USING btree ("repository","pr_number");--> statement-breakpoint
CREATE INDEX "pr_comments_repo_idx" ON "pr_comments" USING btree ("repository");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "projects_org_handle_idx" ON "projects" USING btree ("organization_id","handle");--> statement-breakpoint
CREATE INDEX "projects_org_repo_idx" ON "projects" USING btree ("organization_id","provider_repo_id");--> statement-breakpoint
CREATE INDEX "projects_repo_full_name_idx" ON "projects" USING btree ("provider_repo_full_name");--> statement-breakpoint
CREATE INDEX "projects_repo_id_idx" ON "projects" USING btree ("provider_repo_id");--> statement-breakpoint
CREATE INDEX "resolves_project_status_idx" ON "resolves" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "resolves_project_pr_idx" ON "resolves" USING btree ("project_id","pr_number");--> statement-breakpoint
CREATE INDEX "resolves_status_idx" ON "resolves" USING btree ("status");--> statement-breakpoint
CREATE INDEX "resolves_status_type_updated_at_idx" ON "resolves" USING btree ("status","type","updated_at");--> statement-breakpoint
CREATE INDEX "resolves_run_idx" ON "resolves" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhooks_org_active_idx" ON "webhooks" USING btree ("organization_id","active");