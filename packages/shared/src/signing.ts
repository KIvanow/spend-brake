import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Outgoing webhooks ---------------------------------------------------------------------

export const WEBHOOK_SIGNATURE_HEADER = 'x-brake-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-brake-timestamp';
/** Receivers should reject deliveries older (or newer) than this. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/** `sha256=<hex>` over `<timestamp>.<raw body>`, keyed by the webhook's signing secret. */
export function signWebhook(secret: string, timestampSec: number, body: string): string {
  return `sha256=${hmac(secret, `${timestampSec}.${body}`).toString('hex')}`;
}

/** For receivers: check the signature and the replay window. */
export function verifyWebhook(
  secret: string,
  headers: { signature: string | undefined; timestamp: string | undefined },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isInteger(ts)) return false;
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  return safeEqual(Buffer.from(signWebhook(secret, ts, body)), Buffer.from(headers.signature));
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

// --- Alert action links ---------------------------------------------------------------------

export type ActionKind = 'kill' | 'raise' | 'mute' | 'reset';

export interface ActionClaims {
  v: 1;
  /** Single-use id. */
  jti: string;
  org: string;
  act: ActionKind;
  /** kill: kill target; raise/mute: scope label; reset: key id. */
  target: string;
  /** raise: which window's cap. */
  kind?: 'd' | 'm';
  /** raise: micros to add, or 'custom' (the confirm page asks, up to `max`). */
  amount?: string;
  max?: string;
  /** Unix seconds. */
  exp: number;
  /** The alert this link came from, for the audit log. */
  alert?: string;
}

/** `<payload>.<signature>`, both base64url; HMAC-SHA256 with the server's action secret. */
export function signAction(secret: string, claims: Omit<ActionClaims, 'v' | 'jti'>): string {
  const full: ActionClaims = { v: 1, jti: randomBytes(12).toString('base64url'), ...claims };
  const payload = b64url(JSON.stringify(full));
  return `${payload}.${b64url(hmac(secret, payload))}`;
}

export type ActionCheck =
  | { ok: true; claims: ActionClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** Verify signature and expiry. Single use is enforced by whoever executes the action. */
export function verifyAction(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): ActionCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts as [string, string];
  if (!safeEqual(hmac(secret, payload), Buffer.from(sig, 'base64url'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims: ActionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ActionClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.v !== 1 || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp <= nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
