CREATE TYPE "public"."adcvd_order_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."analysis_finding_category" AS ENUM('adcvd_discrepancy', 'fee_error', 'coo_inconsistency', 'classification_mismatch', 'valuation_concern', 'document_inconsistency', 'duty_calculation', 'other');--> statement-breakpoint
CREATE TYPE "public"."analysis_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."analysis_run_trigger" AS ENUM('manual', 'tariff_apply');--> statement-breakpoint
CREATE TABLE "adcvd_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_number" varchar(20) NOT NULL,
	"country" varchar(2) NOT NULL,
	"merchandise" varchar(200) NOT NULL,
	"scope_summary" text NOT NULL,
	"hts_prefixes" jsonb NOT NULL,
	"status" "adcvd_order_status" DEFAULT 'active' NOT NULL,
	"effective_date" date,
	"revoked_date" date,
	"deposit_rates" jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adcvd_orders_case_number_unique" UNIQUE("case_number")
);
--> statement-breakpoint
CREATE TABLE "analysis_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_item_id" uuid,
	"finding_key" varchar(160) NOT NULL,
	"category" "analysis_finding_category" NOT NULL,
	"severity" "audit_severity" NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"suggested_action" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"line_number" integer,
	"evidence" jsonb NOT NULL,
	"related_alert_keys" jsonb NOT NULL,
	"run_id" uuid,
	"status" "audit_alert_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"status" "analysis_run_status" DEFAULT 'pending' NOT NULL,
	"trigger" "analysis_run_trigger" NOT NULL,
	"analyst" varchar(16),
	"model" varchar(64),
	"summary" text,
	"error" text,
	"usage" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_line_item_id_entry_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."entry_line_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_findings" ADD CONSTRAINT "analysis_findings_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adcvd_orders_country_idx" ON "adcvd_orders" USING btree ("country");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_findings_entry_key_uq" ON "analysis_findings" USING btree ("entry_id","finding_key");--> statement-breakpoint
CREATE INDEX "analysis_findings_org_status_idx" ON "analysis_findings" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "analysis_findings_entry_idx" ON "analysis_findings" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_entry_idx" ON "analysis_runs" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_org_status_idx" ON "analysis_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_entry_pending_uq" ON "analysis_runs" USING btree ("entry_id") WHERE status = 'pending';