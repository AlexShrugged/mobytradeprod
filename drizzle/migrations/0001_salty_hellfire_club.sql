ALTER TYPE "public"."audit_alert_type" ADD VALUE 'coo_discrepancy' BEFORE 'value_mismatch';--> statement-breakpoint
CREATE TABLE "part_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"country_of_origin" varchar(2),
	"unit_cost" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "field_changes" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "country_of_origin" varchar(2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "country_of_origin" varchar(2);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_sheets" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "part_sources" ADD CONSTRAINT "part_sources_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sources" ADD CONSTRAINT "part_sources_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sources" ADD CONSTRAINT "part_sources_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "part_sources_part_vendor_uq" ON "part_sources" USING btree ("part_id","vendor_id");--> statement-breakpoint
CREATE INDEX "part_sources_org_idx" ON "part_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "part_sources_vendor_idx" ON "part_sources" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_org_name_uq" ON "vendors" USING btree ("org_id","name_normalized");--> statement-breakpoint
CREATE INDEX "vendors_org_idx" ON "vendors" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "entry_line_items" ADD CONSTRAINT "entry_line_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sheets" ADD CONSTRAINT "quote_sheets_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "manufacturer";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "unit_cost";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "country_of_origin";