ALTER TABLE "entry_line_items" ALTER COLUMN "hts_code" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "hts_code" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "quote_lines" ALTER COLUMN "hts_code" SET DATA TYPE varchar(32);