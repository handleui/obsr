ALTER TYPE "public"."organization_role" ADD VALUE 'visitor';--> statement-breakpoint
DROP INDEX "organization_members_org_user_idx";--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "provider_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "membership_source" varchar(32);--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "removed_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "removal_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "removed_by" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_active_idx" ON "organization_members" USING btree ("organization_id","user_id") WHERE "organization_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_members_removed_at_idx" ON "organization_members" USING btree ("removed_at");--> statement-breakpoint
CREATE INDEX "organization_members_org_provider_user_idx" ON "organization_members" USING btree ("organization_id","provider_user_id");