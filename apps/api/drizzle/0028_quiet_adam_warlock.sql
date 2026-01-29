ALTER TABLE "run_errors" ADD COLUMN "hints" jsonb;--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "suggestions";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "hint";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "column_known";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "message_truncated";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "stack_trace_truncated";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "exit_code";--> statement-breakpoint
ALTER TABLE "run_errors" DROP COLUMN "is_infrastructure";