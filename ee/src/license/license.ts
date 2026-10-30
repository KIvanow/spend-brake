import {
  LICENSE_FEATURES,
  LICENSE_FORMAT,
  type LicensePayload,
  SignatureError,
  licensePayload,
  verifyDocument,
} from '@spend-brake/shared';
import { LICENSE_PUBLIC_KEY } from './keys.js';

// The format and signing live in @spend-brake/shared (the billing service issues licenses);
// verification and what a license allows live here.
export { LICENSE_FORMAT, licensePayload, signLicense } from '@spend-brake/shared';
export const FEATURES = LICENSE_FEATURES;
export type Feature = (typeof FEATURES)[number];
export type License = LicensePayload;

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
