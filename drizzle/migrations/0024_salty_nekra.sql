ALTER TYPE "public"."analysis_run_trigger" ADD VALUE 'entry_change' BEFORE 'org_rule';--> statement-breakpoint
ALTER TYPE "public"."analysis_run_trigger" ADD VALUE 'backfill' BEFORE 'org_rule';