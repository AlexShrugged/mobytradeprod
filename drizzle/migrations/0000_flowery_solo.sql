CREATE TYPE "public"."announcement_source" AS ENUM('usitc_hts', 'federal_register', 'manual');--> statement-breakpoint
CREATE TYPE "public"."announcement_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."audit_alert_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."audit_alert_type" AS ENUM('missing_measure', 'unexpected_measure', 'rate_mismatch', 'amount_mismatch', 'hts_discrepancy', 'value_mismatch', 'data_unreconciled', 'sail_date_assumption');--> statement-breakpoint
CREATE TYPE "public"."audit_severity" AS ENUM('error', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."charge_type" AS ENUM('base_duty', 'additional_duty', 'mpf', 'hmf', 'antidumping', 'countervailing', 'other_fee');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('port_entry', 'shipment', 'purchase_order', 'commercial_invoice', 'packing_list', 'quote_sheet', 'refund_report', 'other');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('draft', 'filed', 'released', 'liquidated');--> statement-breakpoint
CREATE TYPE "public"."hts_classification_outcome" AS ENUM('certain', 'ambiguous', 'none');--> statement-breakpoint
CREATE TYPE "public"."hts_classification_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hts_rate_type" AS ENUM('free', 'ad_valorem', 'specific', 'compound', 'other');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('manual_upload', 'sftp', 'email_inbox', 'erp');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'paused', 'error', 'not_configured');--> statement-breakpoint
CREATE TYPE "public"."linked_entity_type" AS ENUM('entry', 'shipment', 'purchase_order', 'refund_claim', 'invoice', 'quote_sheet', 'part');--> statement-breakpoint
CREATE TYPE "public"."measure_authority" AS ENUM('section_301', 'section_232_steel', 'section_232_aluminum', 'ieepa', 'reciprocal', 'section_122', 'other');--> statement-breakpoint
CREATE TYPE "public"."measure_scope" AS ENUM('hts_list', 'all_products');--> statement-breakpoint
CREATE TYPE "public"."part_hts_review_status" AS ENUM('pending', 'confirmed', 'accepted', 'rejected', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."part_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('open', 'partially_received', 'received', 'closed');--> statement-breakpoint
CREATE TYPE "public"."quote_line_status" AS ENUM('received', 'approved', 'rejected', 'superseded', 'applied');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('accept', 'reject', 'acknowledge', 'manual');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('pending', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."review_item_type" AS ENUM('hts_classification', 'tariff_measure_revision');--> statement-breakpoint
CREATE TYPE "public"."revision_change_type" AS ENUM('create_measure', 'rate_change', 'scope_change', 'end_measure', 'stacking_change', 'note_change');--> statement-breakpoint
CREATE TYPE "public"."shipment_mode" AS ENUM('ocean', 'air', 'truck', 'rail');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('booked', 'in_transit', 'arrived', 'delivered');--> statement-breakpoint
CREATE TABLE "audit_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_item_id" uuid,
	"alert_key" varchar(160) NOT NULL,
	"alert_type" "audit_alert_type" NOT NULL,
	"severity" "audit_severity" NOT NULL,
	"label" varchar(120) NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"status" "audit_alert_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" "linked_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_links_document_id_entity_type_entity_id_pk" PRIMARY KEY("document_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"doc_type" "document_type" DEFAULT 'other' NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"source_id" uuid,
	"extracted_data" jsonb,
	"raw_extraction" jsonb,
	"parse_job_id" text,
	"processed_by" text,
	"error_message" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_number" varchar(32) NOT NULL,
	"entry_date" date,
	"port_of_entry" varchar(64),
	"entry_type" varchar(16),
	"importer_of_record" text,
	"status" "entry_status" DEFAULT 'draft' NOT NULL,
	"total_entered_value" numeric(14, 2),
	"total_duty" numeric(12, 2),
	"total_base_duty" numeric(12, 2),
	"mpf_amount" numeric(10, 2),
	"hmf_amount" numeric(10, 2),
	"total_refund" numeric(12, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_line_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"line_item_id" uuid NOT NULL,
	"charge_type" charge_type NOT NULL,
	"hts_code" varchar(15),
	"hts_code_digits" varchar(10),
	"rate" numeric(10, 6),
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"part_id" uuid,
	"sku" varchar(64),
	"description" text,
	"hts_code" varchar(12) NOT NULL,
	"hts_code_digits" varchar(10) NOT NULL,
	"country_of_origin" varchar(2),
	"quantity" numeric(15, 4),
	"unit_value" numeric(12, 4),
	"entered_value" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_purchase_orders" (
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_purchase_orders_entry_id_purchase_order_id_pk" PRIMARY KEY("entry_id","purchase_order_id")
);
--> statement-breakpoint
CREATE TABLE "entry_shipments" (
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_shipments_entry_id_shipment_id_pk" PRIMARY KEY("entry_id","shipment_id")
);
--> statement-breakpoint
CREATE TABLE "field_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" varchar(64) NOT NULL,
	"old_value" text,
	"new_value" text,
	"source" varchar(40) NOT NULL,
	"actor" text,
	"note" text,
	"review_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_classification_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"classification_id" uuid NOT NULL,
	"code" varchar(15) NOT NULL,
	"code_digits" varchar(10) NOT NULL,
	"description" text,
	"confidence" numeric(5, 4),
	"reason" text,
	"position" integer NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_classifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"status" "hts_classification_status" DEFAULT 'completed' NOT NULL,
	"outcome" "hts_classification_outcome",
	"classifier" varchar(32) NOT NULL,
	"confidence" numeric(5, 4),
	"reasoning" text,
	"error_message" text,
	"input" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(15) NOT NULL,
	"code_digits" varchar(10) NOT NULL,
	"description" text NOT NULL,
	"chapter" integer NOT NULL,
	"rate_type" "hts_rate_type" DEFAULT 'ad_valorem' NOT NULL,
	"rate" numeric(10, 6),
	"col1_general" text,
	"col1_special" text,
	"col2_rate" text,
	"unit_of_quantity" text,
	"indent" integer,
	"parent_digits" varchar(10),
	"rate_inherited_from" varchar(10),
	"release" text,
	"valid_from" date,
	"valid_to" date,
	"trade_measure_id" uuid,
	"exemption" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "integration_status" DEFAULT 'not_configured' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_received_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"part_id" uuid,
	"sku" varchar(64),
	"description" text,
	"quantity" numeric(15, 4),
	"unit_price" numeric(12, 4),
	"total_price" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_number" varchar(64) NOT NULL,
	"purchase_order_id" uuid,
	"supplier_name" text,
	"invoice_date" date,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"total_amount" numeric(12, 2),
	"incoterms" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measure_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"announcement_id" uuid NOT NULL,
	"change_type" "revision_change_type" NOT NULL,
	"ch99_code" varchar(15),
	"authority" "measure_authority",
	"target_measure_id" uuid,
	"proposed" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"live_snapshot" jsonb,
	"content_hash" varchar(64) NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_measure_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"importer_of_record" text,
	"inbox_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sku" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"manufacturer" text,
	"unit_of_measure" varchar(16) DEFAULT 'EA' NOT NULL,
	"unit_cost" numeric(10, 4),
	"country_of_origin" varchar(2),
	"hts_code" varchar(12),
	"hts_code_provisional" boolean DEFAULT false NOT NULL,
	"hts_review_status" "part_hts_review_status",
	"status" "part_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposed_measures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"authority" "measure_authority" NOT NULL,
	"scope" "measure_scope" DEFAULT 'hts_list' NOT NULL,
	"countries" varchar(2)[],
	"rate" numeric(10, 6) NOT NULL,
	"in_lieu_of_base_duty" boolean DEFAULT false NOT NULL,
	"hts_prefixes" varchar(10)[] DEFAULT '{}' NOT NULL,
	"exclusion_prefixes" varchar(10)[] DEFAULT '{}' NOT NULL,
	"announced_date" date,
	"expected_effective_date" date,
	"source_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"part_id" uuid,
	"sku" varchar(64),
	"description" text,
	"quantity" numeric(15, 4),
	"unit_price" numeric(12, 4),
	"total_price" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"po_number" varchar(32) NOT NULL,
	"supplier_name" text,
	"order_date" date,
	"expected_date" date,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"total_amount" numeric(12, 2),
	"status" "po_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"quote_sheet_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"part_id" uuid NOT NULL,
	"part_created" boolean DEFAULT false NOT NULL,
	"sku" varchar(64) NOT NULL,
	"description" text,
	"unit_cost" numeric(10, 4) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"country_of_origin" varchar(2),
	"hts_code" varchar(12),
	"moq" numeric(15, 4),
	"lead_time_days" integer,
	"unit_of_measure" varchar(16),
	"status" "quote_line_status" DEFAULT 'received' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_at" timestamp with time zone,
	"applied_po_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_sheets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid,
	"supplier_name" text,
	"quote_date" date,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"valid_until" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_summary_number" varchar(32) NOT NULL,
	"normalized_entry_number" varchar(16) NOT NULL,
	"entry_id" uuid,
	"claim_type" varchar(64) NOT NULL,
	"claim_status" varchar(64),
	"refund_status" varchar(64),
	"refund_number" varchar(32),
	"refund_class_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"refund_interest_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"entry_date" date,
	"liquidation_date" date,
	"refund_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"item_type" "review_item_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload_id" uuid,
	"proposal" jsonb NOT NULL,
	"status" "review_item_status" DEFAULT 'pending' NOT NULL,
	"resolution_action" "review_action",
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_purchase_orders" (
	"org_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_purchase_orders_shipment_id_purchase_order_id_pk" PRIMARY KEY("shipment_id","purchase_order_id")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"shipment_number" varchar(32) NOT NULL,
	"bill_of_lading" varchar(32),
	"container_number" varchar(16),
	"carrier" text,
	"vessel" text,
	"mode" "shipment_mode" DEFAULT 'ocean' NOT NULL,
	"origin_port" text,
	"destination_port" text,
	"etd" date,
	"eta" date,
	"sailed_on_board_date" date,
	"status" "shipment_status" DEFAULT 'booked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stacking_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"winner_authority" "measure_authority" NOT NULL,
	"loser_authority" "measure_authority" NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date NOT NULL,
	"end_date" date,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "announcement_source" NOT NULL,
	"source_ref" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"published_date" date,
	"fetched_at" timestamp with time zone NOT NULL,
	"raw_storage_key" text,
	"summary" text,
	"status" "announcement_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_measure_hts" (
	"trade_measure_id" uuid NOT NULL,
	"hts_prefix" varchar(10) NOT NULL,
	CONSTRAINT "trade_measure_hts_trade_measure_id_hts_prefix_pk" PRIMARY KEY("trade_measure_id","hts_prefix")
);
--> statement-breakpoint
CREATE TABLE "trade_measures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"authority" "measure_authority" NOT NULL,
	"scope" "measure_scope" DEFAULT 'hts_list' NOT NULL,
	"countries" varchar(2)[],
	"effective_date" date NOT NULL,
	"end_date" date,
	"sailed_on_or_after" date,
	"sailed_on_or_before" date,
	"predecessor_id" uuid,
	"in_lieu_of_base_duty" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_alerts" ADD CONSTRAINT "audit_alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_alerts" ADD CONSTRAINT "audit_alerts_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_alerts" ADD CONSTRAINT "audit_alerts_line_item_id_entry_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."entry_line_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_integration_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."integration_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_charges" ADD CONSTRAINT "entry_line_charges_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_charges" ADD CONSTRAINT "entry_line_charges_line_item_id_entry_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."entry_line_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD CONSTRAINT "entry_line_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD CONSTRAINT "entry_line_items_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD CONSTRAINT "entry_line_items_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_purchase_orders" ADD CONSTRAINT "entry_purchase_orders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_purchase_orders" ADD CONSTRAINT "entry_purchase_orders_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_purchase_orders" ADD CONSTRAINT "entry_purchase_orders_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_shipments" ADD CONSTRAINT "entry_shipments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_shipments" ADD CONSTRAINT "entry_shipments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_shipments" ADD CONSTRAINT "entry_shipments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hts_classification_candidates" ADD CONSTRAINT "hts_classification_candidates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hts_classification_candidates" ADD CONSTRAINT "hts_classification_candidates_classification_id_hts_classifications_id_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."hts_classifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hts_classifications" ADD CONSTRAINT "hts_classifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hts_classifications" ADD CONSTRAINT "hts_classifications_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hts_codes" ADD CONSTRAINT "hts_codes_trade_measure_id_trade_measures_id_fk" FOREIGN KEY ("trade_measure_id") REFERENCES "public"."trade_measures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sources" ADD CONSTRAINT "integration_sources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD CONSTRAINT "measure_revisions_announcement_id_tariff_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."tariff_announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD CONSTRAINT "measure_revisions_target_measure_id_trade_measures_id_fk" FOREIGN KEY ("target_measure_id") REFERENCES "public"."trade_measures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD CONSTRAINT "measure_revisions_applied_measure_id_trade_measures_id_fk" FOREIGN KEY ("applied_measure_id") REFERENCES "public"."trade_measures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_sheet_id_quote_sheets_id_fk" FOREIGN KEY ("quote_sheet_id") REFERENCES "public"."quote_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_applied_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("applied_po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sheets" ADD CONSTRAINT "quote_sheets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sheets" ADD CONSTRAINT "quote_sheets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_claims" ADD CONSTRAINT "refund_claims_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_claims" ADD CONSTRAINT "refund_claims_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_purchase_orders" ADD CONSTRAINT "shipment_purchase_orders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_purchase_orders" ADD CONSTRAINT "shipment_purchase_orders_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_purchase_orders" ADD CONSTRAINT "shipment_purchase_orders_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_measure_hts" ADD CONSTRAINT "trade_measure_hts_trade_measure_id_trade_measures_id_fk" FOREIGN KEY ("trade_measure_id") REFERENCES "public"."trade_measures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_measures" ADD CONSTRAINT "trade_measures_predecessor_id_trade_measures_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."trade_measures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_alerts_entry_key_uq" ON "audit_alerts" USING btree ("entry_id","alert_key");--> statement-breakpoint
CREATE INDEX "audit_alerts_org_status_idx" ON "audit_alerts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "audit_alerts_entry_idx" ON "audit_alerts" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "dl_entity_idx" ON "document_links" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entries_org_number_uq" ON "entries" USING btree ("org_id","entry_number");--> statement-breakpoint
CREATE INDEX "entries_org_idx" ON "entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "elc_line_idx" ON "entry_line_charges" USING btree ("line_item_id");--> statement-breakpoint
CREATE INDEX "elc_org_idx" ON "entry_line_charges" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eli_entry_line_uq" ON "entry_line_items" USING btree ("entry_id","line_number");--> statement-breakpoint
CREATE INDEX "eli_org_idx" ON "entry_line_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "eli_part_idx" ON "entry_line_items" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "epo_po_idx" ON "entry_purchase_orders" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "es_shipment_idx" ON "entry_shipments" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "field_changes_entity_idx" ON "field_changes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hts_cand_rank_uq" ON "hts_classification_candidates" USING btree ("classification_id","position");--> statement-breakpoint
CREATE INDEX "hts_cand_class_idx" ON "hts_classification_candidates" USING btree ("classification_id");--> statement-breakpoint
CREATE INDEX "hts_class_part_idx" ON "hts_classifications" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "hts_class_org_idx" ON "hts_classifications" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hts_codes_digits_measure_uq" ON "hts_codes" USING btree ("code_digits","trade_measure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hts_codes_digits_base_current_uq" ON "hts_codes" USING btree ("code_digits") WHERE "hts_codes"."trade_measure_id" is null and "hts_codes"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "hts_codes_measure_idx" ON "hts_codes" USING btree ("trade_measure_id");--> statement-breakpoint
CREATE INDEX "hts_codes_digits_idx" ON "hts_codes" USING btree ("code_digits");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_sources_org_kind_name_uq" ON "integration_sources" USING btree ("org_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ili_invoice_line_uq" ON "invoice_line_items" USING btree ("invoice_id","line_number");--> statement-breakpoint
CREATE INDEX "ili_org_idx" ON "invoice_line_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ili_part_idx" ON "invoice_line_items" USING btree ("part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_number_uq" ON "invoices" USING btree ("org_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_po_idx" ON "invoices" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "measure_revisions_announcement_idx" ON "measure_revisions" USING btree ("announcement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "measure_revisions_announcement_code_uq" ON "measure_revisions" USING btree ("announcement_id","ch99_code") WHERE "measure_revisions"."ch99_code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "parts_org_sku_uq" ON "parts" USING btree ("org_id","sku");--> statement-breakpoint
CREATE INDEX "parts_org_idx" ON "parts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pol_po_line_uq" ON "purchase_order_lines" USING btree ("purchase_order_id","line_number");--> statement-breakpoint
CREATE INDEX "pol_org_idx" ON "purchase_order_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pol_part_idx" ON "purchase_order_lines" USING btree ("part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_org_number_uq" ON "purchase_orders" USING btree ("org_id","po_number");--> statement-breakpoint
CREATE INDEX "pos_org_idx" ON "purchase_orders" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_lines_sheet_line_uq" ON "quote_lines" USING btree ("quote_sheet_id","line_number");--> statement-breakpoint
CREATE INDEX "quote_lines_part_status_idx" ON "quote_lines" USING btree ("org_id","part_id","status");--> statement-breakpoint
CREATE INDEX "quote_lines_sheet_idx" ON "quote_lines" USING btree ("quote_sheet_id");--> statement-breakpoint
CREATE INDEX "quote_sheets_org_idx" ON "quote_sheets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "quote_sheets_document_idx" ON "quote_sheets" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_claims_org_entry_type_uq" ON "refund_claims" USING btree ("org_id","entry_summary_number","claim_type");--> statement-breakpoint
CREATE INDEX "refund_claims_entry_idx" ON "refund_claims" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "refund_claims_norm_idx" ON "refund_claims" USING btree ("normalized_entry_number");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_open_subject_uq" ON "review_items" USING btree ("item_type","subject_id") WHERE "review_items"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "review_items_org_status_idx" ON "review_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scenarios_org_name_uq" ON "scenarios" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "scenarios_org_idx" ON "scenarios" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "spo_po_idx" ON "shipment_purchase_orders" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_org_number_uq" ON "shipments" USING btree ("org_id","shipment_number");--> statement-breakpoint
CREATE INDEX "shipments_org_idx" ON "shipments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stacking_rules_pair_eff_uq" ON "stacking_rules" USING btree ("winner_authority","loser_authority","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_announcements_source_ref_uq" ON "tariff_announcements" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "tmh_prefix_idx" ON "trade_measure_hts" USING btree ("hts_prefix");--> statement-breakpoint
CREATE INDEX "trade_measures_authority_idx" ON "trade_measures" USING btree ("authority");