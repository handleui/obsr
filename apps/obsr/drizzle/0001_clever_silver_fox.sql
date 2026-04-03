DROP INDEX "issues_last_seen_at_idx";--> statement-breakpoint
DROP INDEX "issues_cluster_key_idx";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_owner_last_seen_idx" ON "issues" USING btree ("owner_user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "issues_owner_cluster_key_idx" ON "issues" USING btree ("owner_user_id","cluster_key");