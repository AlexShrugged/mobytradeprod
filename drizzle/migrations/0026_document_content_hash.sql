ALTER TABLE "documents" ADD COLUMN "content_hash" varchar(64);--> statement-breakpoint
CREATE INDEX "documents_hash_idx" ON "documents" USING btree ("org_id","content_hash");