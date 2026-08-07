ALTER TYPE "public"."audit_alert_type" ADD VALUE 'hts_reclassified' BEFORE 'value_mismatch';--> statement-breakpoint
CREATE TABLE "part_classifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"hts_code" varchar(12) NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"source" varchar(40) NOT NULL,
	"actor" text,
	"note" text,
	"review_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "part_sources_part_vendor_uq";--> statement-breakpoint
ALTER TABLE "part_sources" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "part_sources" ADD COLUMN "valid_to" date;--> statement-breakpoint
ALTER TABLE "part_classifications" ADD CONSTRAINT "part_classifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_classifications" ADD CONSTRAINT "part_classifications_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_classifications" ADD CONSTRAINT "part_classifications_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "part_classifications_current_uq" ON "part_classifications" USING btree ("part_id") WHERE "part_classifications"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "part_classifications_part_idx" ON "part_classifications" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "part_classifications_org_idx" ON "part_classifications" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "part_sources_part_vendor_current_uq" ON "part_sources" USING btree ("part_id","vendor_id") WHERE "part_sources"."valid_to" is null;--> statement-breakpoint
INSERT INTO "part_classifications"
  ("id", "org_id", "part_id", "hts_code", "valid_from", "valid_to", "source", "created_at", "updated_at")
SELECT gen_random_uuid(), p."org_id", p."id", p."hts_code", NULL, NULL, 'backfill', now(), now()
FROM "parts" p
WHERE p."hts_code" IS NOT NULL AND p."hts_code_provisional" = false;
