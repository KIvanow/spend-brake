ALTER TABLE "api_tokens" ADD COLUMN "sign_in" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_email" ON "users" USING btree ("email");