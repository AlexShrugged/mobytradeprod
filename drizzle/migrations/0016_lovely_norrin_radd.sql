ALTER TYPE "public"."document_type" ADD VALUE 'cargo_release' BEFORE 'shipment';--> statement-breakpoint
ALTER TYPE "public"."packet_role" ADD VALUE 'cargo_release' BEFORE 'commercial_invoice';