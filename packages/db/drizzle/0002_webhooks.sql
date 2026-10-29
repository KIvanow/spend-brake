CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"type" text NOT NULL,
	"attempt" bigint NOT NULL,
	"ok" boolean NOT NULL,
	"http_status" bigint,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"preset" text NOT NULL,
	"url_envelope" jsonb NOT NULL,
	"url_hint" text NOT NULL,
	"secret_envelope" jsonb NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_hook_at" ON "webhook_deliveries" USING btree ("webhook_id","at");--> statement-breakpoint
CREATE INDEX "webhooks_org" ON "webhooks" USING btree ("org_id");