CREATE TYPE "public"."fact_citation_entity_type" AS ENUM('entry', 'entry_line_item', 'entry_line_charge', 'invoice', 'invoice_line_item');--> statement-breakpoint
CREATE TABLE "fact_citations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" "fact_citation_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" varchar(64) NOT NULL,
	"page" integer NOT NULL,
	"boxes" jsonb NOT NULL,
	"printed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fact_citations" ADD CONSTRAINT "fact_citations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_citations" ADD CONSTRAINT "fact_citations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_citations_entity_field_uq" ON "fact_citations" USING btree ("entity_type","entity_id","field");--> statement-breakpoint
CREATE INDEX "fact_citations_document_idx" ON "fact_citations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "fact_citations_org_idx" ON "fact_citations" USING btree ("org_id");