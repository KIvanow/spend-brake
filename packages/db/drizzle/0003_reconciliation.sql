CREATE TABLE "reconciliation_configs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"export_table" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"service_account" text NOT NULL,
	"project_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "reconciliation_results" (
	"org_id" text NOT NULL,
	"day" text NOT NULL,
	"family" text NOT NULL,
	"ledger_micros" bigint NOT NULL,
	"billed_micros" bigint NOT NULL,
	"drift_ratio" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_results_org_id_day_family_pk" PRIMARY KEY("org_id","day","family")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_configs" ADD CONSTRAINT "reconciliation_configs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;