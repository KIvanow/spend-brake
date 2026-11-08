-- Hand-written: orgs licensed before license_org was stored get the install id their latest
-- license names, so Billing shows it and renewals use it like any other stored id.
UPDATE "org_entitlements" SET "license_org" = (
  SELECT "license_org" FROM "issued_licenses"
  WHERE "issued_licenses"."org_id" = "org_entitlements"."org_id" AND "issued_licenses"."license_org" IS NOT NULL
  ORDER BY "issued_licenses"."issued_at" DESC LIMIT 1
)
WHERE "license_org" IS NULL AND EXISTS (
  SELECT 1 FROM "issued_licenses"
  WHERE "issued_licenses"."org_id" = "org_entitlements"."org_id" AND "issued_licenses"."license_org" IS NOT NULL
);
