ALTER TABLE "issued_licenses" ADD COLUMN "license_org" text;--> statement-breakpoint
-- Hand-written: licenses issued before the column get the org their signed payload names (the
-- payload is base64url JSON inside the license file's JSON).
UPDATE "issued_licenses" SET "license_org" = convert_from(decode(rpad(translate("raw"::jsonb->>'payload', '-_', '+/'), (length("raw"::jsonb->>'payload') + 3) / 4 * 4, '='), 'base64'), 'UTF8')::jsonb->>'org';
