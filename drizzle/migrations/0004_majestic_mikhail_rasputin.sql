CREATE TYPE "public"."packet_role" AS ENUM('entry_summary_7501', 'commercial_invoice', 'assist_sheet', 'packing_list', 'transport_document', 'certificate_of_origin', 'hts_code_list', 'other');--> statement-breakpoint
ALTER TYPE "public"."audit_alert_type" ADD VALUE 'quantity_discrepancy';--> statement-breakpoint
ALTER TYPE "public"."audit_alert_type" ADD VALUE 'invoice_hts_mismatch';--> statement-breakpoint
ALTER TYPE "public"."audit_alert_type" ADD VALUE 'invoice_sku_missing';--> statement-breakpoint
ALTER TYPE "public"."audit_alert_type" ADD VALUE 'invoice_comparison_skipped';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'entry_packet' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "entry_invoices" (
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_invoices_entry_id_invoice_id_pk" PRIMARY KEY("entry_id","invoice_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "parent_document_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "packet_role" "packet_role";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_range" integer[];--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "hts_code" varchar(12);--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "hts_code_digits" varchar(10);--> statement-breakpoint
ALTER TABLE "entry_invoices" ADD CONSTRAINT "entry_invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_invoices" ADD CONSTRAINT "entry_invoices_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_invoices" ADD CONSTRAINT "entry_invoices_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ei_invoice_idx" ON "entry_invoices" USING btree ("invoice_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_document_id_documents_id_fk" FOREIGN KEY ("parent_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_parent_idx" ON "documents" USING btree ("parent_document_id");