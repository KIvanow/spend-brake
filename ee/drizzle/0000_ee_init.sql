CREATE TABLE "ee_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"from_hard_micros" bigint,
	"to_hard_micros" bigint,
	"to_soft_micros" bigint,
	"remove" boolean DEFAULT false NOT NULL,
	"via" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "ee_catalog_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_export_cursors" (
	"sink" text PRIMARY KEY NOT NULL,
	"last_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_licenses" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"raw" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"installed_by" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_org_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"cap_approvals" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_sso_configs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"settings" jsonb NOT NULL,
	"groups_claim" text DEFAULT 'groups' NOT NULL,
	"role_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_role" text,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_token_roles" (
	"token_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ee_approvals_org_status" ON "ee_approvals" USING btree ("org_id","status");