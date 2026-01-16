CREATE TABLE "usage_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" varchar(36) NOT NULL,
	"event_name" varchar(64) NOT NULL,
	"metadata" jsonb,
	"polar_ingested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "polar_customer_id" varchar(255);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_org_id_idx" ON "usage_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_events_polar_ingested_idx" ON "usage_events" USING btree ("polar_ingested");