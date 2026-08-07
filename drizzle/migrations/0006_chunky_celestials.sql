ALTER TABLE "entries" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."entry_status";--> statement-breakpoint
DROP TYPE "public"."po_status";