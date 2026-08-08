ALTER TYPE "public"."review_item_type" ADD VALUE 'tariff_measure_group';--> statement-breakpoint
ALTER TYPE "public"."review_item_type" ADD VALUE 'tariff_base_release';--> statement-breakpoint
CREATE TABLE "measure_revision_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"announcement_id" uuid NOT NULL,
	"authority" "measure_authority" NOT NULL,
	"ch99_prefix" varchar(6) NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_items" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "measure_revision_groups" ADD CONSTRAINT "measure_revision_groups_announcement_id_tariff_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."tariff_announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mrg_announcement_key_uq" ON "measure_revision_groups" USING btree ("announcement_id","authority","ch99_prefix");--> statement-breakpoint
ALTER TABLE "measure_revisions" ADD CONSTRAINT "measure_revisions_group_id_measure_revision_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."measure_revision_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "review_items" SET "org_id" = NULL WHERE "item_type" = 'tariff_measure_revision';--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_scope_check" CHECK (("review_items"."org_id" is null) = ("review_items"."item_type"::text in ('tariff_measure_revision', 'tariff_measure_group', 'tariff_base_release')));