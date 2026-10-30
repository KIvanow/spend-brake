import { z } from 'zod';
import { LICENSE_PUBLIC_KEY } from './keys.js';
import { SignatureError, signDocument, verifyDocument } from './signed.js';

export const LICENSE_FORMAT = 'spend-brake-license/1';

export const FEATURES = [
  'sso',
  'rbac',
  'approvals',
  'audit_export',
  'multi_org',
  'catalog_feed',
  'reconciliation',
] as const;
export type Feature = (typeof FEATURES)[number];

export const licensePayload = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** The org this install's license belongs to; its owners manage the license and other orgs. */
  org: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  edition: z.enum(['business', 'enterprise']),
  features: z.array(z.enum(FEATURES)),
  /** Orgs this install may hold. */
  orgUnits: z.number().int().positive(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type License = z.infer<typeof licensePayload>;

/** After expiry the license keeps working this long; then its features turn read-only. */
export const GRACE_MS = 14 * 24 * 3600_000;

export class LicenseError extends Error {
  constructor(
    readonly code: 'malformed' | 'bad_signature' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export function signLicense(license: License, privateKeyPem: string): string {
  return signDocument(LICENSE_FORMAT, licensePayload.parse(license), privateKeyPem);
}

/** Verify a license file offline. Expiry is not checked here (see licenseState). */
export function verifyLicense(text: string, publicKeyPem = LICENSE_PUBLIC_KEY): License {
  let payload: unknown;
  try {
    payload = verifyDocument(text, LICENSE_FORMAT, publicKeyPem);
  } catch (err) {
    if (err instanceof SignatureError) throw new LicenseError(err.code, err.message);
    throw err;
  }
  const parsed = licensePayload.safeParse(payload);
  if (!parsed.success) throw new LicenseError('invalid', 'The license fields are not valid.');
  if (Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.issuedAt)) {
    throw new LicenseError('invalid', 'The license expires before it was issued.');
  }
  return parsed.data;
}

export type LicenseStatus = 'missing' | 'active' | 'grace' | 'expired';

export interface LicenseState {
  status: LicenseStatus;
  license: License | null;
  /** When features turn read-only (expiry + 14 days). */
  readOnlyAt: string | null;
}

export function licenseState(license: License | null, now: Date): LicenseState {
  if (!license) return { status: 'missing', license: null, readOnlyAt: null };
  const expires = Date.parse(license.expiresAt);
  const readOnlyAt = new Date(expires + GRACE_MS);
  const status =
    now.getTime() < expires ? 'active' : now < readOnlyAt ? 'grace' : ('expired' as const);
  return { status, license, readOnlyAt: readOnlyAt.toISOString() };
}

/**
 * Whether a feature may be used: reads need the feature in a license (expired ones included),
 * changes need an active license or one in its grace period.
 */
export function allows(state: LicenseState, feature: Feature, mode: 'read' | 'write'): boolean {
  if (!state.license?.features.includes(feature)) return false;
  return mode === 'read' || state.status === 'active' || state.status === 'grace';
}
