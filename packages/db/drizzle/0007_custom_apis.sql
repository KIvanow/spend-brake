CREATE TABLE "custom_apis" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"auth" jsonb NOT NULL,
	"routes" jsonb NOT NULL,
	"billed" text DEFAULT '2xx' NOT NULL,
	"timeout_billed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_apis_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD COLUMN "max_custom_apis" bigint;--> statement-breakpoint
ALTER TABLE "custom_apis" ADD CONSTRAINT "custom_apis_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written: existing plans get their custom API limit (null would mean unlimited).
UPDATE "org_entitlements" SET "max_custom_apis" = CASE "plan" WHEN 'indie' THEN 3 WHEN 'team' THEN 10 WHEN 'agents' THEN 25 ELSE 1 END;
