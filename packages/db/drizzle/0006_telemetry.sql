CREATE TABLE "telemetry_exports" (
	"org_id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"headers_envelope" jsonb NOT NULL,
	"header_names" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD COLUMN "otel_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_exports" ADD CONSTRAINT "telemetry_exports_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;