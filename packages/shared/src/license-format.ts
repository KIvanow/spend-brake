import { z } from 'zod';
import { signDocument } from './signed-document.js';

// The license file format: a public contract between whoever issues licenses (the billing
// service) and the Business / Enterprise features that verify them (ee/). Verifying and
// enforcing a license lives in ee/; issuing one only needs the format and the private key.

export const LICENSE_FORMAT = 'spend-brake-license/1';

export const LICENSE_FEATURES = [
  'sso',
  'rbac',
  'approvals',
  'audit_export',
  'multi_org',
  'catalog_feed',
  'reconciliation',
] as const;
export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

export const licensePayload = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** The org this install's license belongs to; its owners manage the license and other orgs. */
  org: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  edition: z.enum(['business', 'enterprise']),
  features: z.array(z.enum(LICENSE_FEATURES)),
  /** Orgs this install may hold. */
  orgUnits: z.number().int().positive(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type LicensePayload = z.infer<typeof licensePayload>;

/** Sign a license with the issuer's Ed25519 private key (PEM). */
export function signLicense(license: LicensePayload, privateKeyPem: string): string {
  return signDocument(LICENSE_FORMAT, licensePayload.parse(license), privateKeyPem);
}
