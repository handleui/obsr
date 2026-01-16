DROP INDEX "usage_events_polar_ingested_idx";--> statement-breakpoint
CREATE INDEX "usage_events_polar_ingested_created_at_idx" ON "usage_events" USING btree ("polar_ingested","created_at");