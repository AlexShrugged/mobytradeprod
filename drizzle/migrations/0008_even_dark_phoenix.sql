ALTER TYPE "public"."measure_authority" ADD VALUE 'section_232_copper' BEFORE 'ieepa';--> statement-breakpoint
ALTER TYPE "public"."measure_authority" ADD VALUE 'section_232_autos' BEFORE 'ieepa';--> statement-breakpoint
ALTER TYPE "public"."measure_authority" ADD VALUE 'section_232_timber_furniture' BEFORE 'ieepa';--> statement-breakpoint
ALTER TYPE "public"."measure_authority" ADD VALUE 'section_232_pharma' BEFORE 'ieepa';--> statement-breakpoint
ALTER TYPE "public"."measure_authority" ADD VALUE 'section_338' BEFORE 'ieepa';--> statement-breakpoint
ALTER TABLE "trade_measures" ADD COLUMN "countries_excluded" varchar(2)[];