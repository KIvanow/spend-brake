CREATE TABLE "issued_licenses" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"edition" text NOT NULL,
	"invoice_id" text NOT NULL,
	"raw" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_licenses_invoice_id_unique" UNIQUE("invoice_id")
);
--> statement-breakpoint
CREATE TABLE "org_entitlements" (
	"org_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_keys" bigint,
	"max_providers" bigint,
	"agent_sessions_per_month" bigint,
	"requests_per_month" bigint,
	"max_org_month_cap_micros" bigint,
	"retention_days" bigint NOT NULL,
	"session_analytics" boolean DEFAULT false NOT NULL,
	"custom_loop_rules" boolean DEFAULT false NOT NULL,
	"billing_email" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD CONSTRAINT "issued_licenses_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD CONSTRAINT "org_entitlements_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issued_licenses_org" ON "issued_licenses" USING btree ("org_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_entitlements_customer" ON "org_entitlements" USING btree ("stripe_customer_id");