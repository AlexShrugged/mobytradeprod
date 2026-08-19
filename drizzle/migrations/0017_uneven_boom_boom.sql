CREATE TABLE "org_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"text" text NOT NULL,
	"suppression" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "context_path" text;--> statement-breakpoint
ALTER TABLE "org_rules" ADD CONSTRAINT "org_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_rules_org_enabled_idx" ON "org_rules" USING btree ("org_id","enabled");