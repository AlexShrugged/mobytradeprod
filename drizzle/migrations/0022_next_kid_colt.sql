ALTER TYPE "public"."document_type" ADD VALUE 'tariff_code_sheet' BEFORE 'part_catalog';--> statement-breakpoint
CREATE TABLE "entry_line_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"sku" varchar(64) NOT NULL,
	"part_id" uuid,
	"po_number" varchar(64),
	"source_document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_line_parts" ADD CONSTRAINT "entry_line_parts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_parts" ADD CONSTRAINT "entry_line_parts_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_parts" ADD CONSTRAINT "entry_line_parts_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_line_parts" ADD CONSTRAINT "entry_line_parts_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "elp_entry_line_sku_uq" ON "entry_line_parts" USING btree ("entry_id","line_number","sku");--> statement-breakpoint
CREATE INDEX "elp_org_idx" ON "entry_line_parts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "elp_part_idx" ON "entry_line_parts" USING btree ("part_id");