import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { parse } from 'yaml';
import { z } from 'zod';
import { readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { parseUsd } from '../pricing.js';
import type {
  Classified,
  IncomingReq,
  OutgoingReq,
  PricedClassified,
  ProviderAdapter,
  UpstreamRes,
} from '../types.js';
import { countSegments } from './segments.js';

export const TWILIO = 'twilio';
const API = 'https://api.twilio.com';
const VERIFY = 'https://verify.twilio.com';

const usd = z.string().regex(/^\d+(\.\d{1,6})?$/);
const smsSchema = z.object({
  source: z.url(),
  verifiedAt: z.string(),
  usCarrierFees: z.object({ sms: usd, mms: usd }),
  mms: z.record(z.string(), usd),
  countries: z.record(z.string(), z.object({ name: z.string(), sms: usd })),
});
const verifySchema = z.object({
  source: z.url(),
  verifiedAt: z.string(),
  baseFee: usd,
  channels: z.record(
    z.string(),
    z.object({
      fee: z.union([usd, z.literal('sms'), z.null()]),
      countries: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * Price per unit (micros) for every Twilio SKU: `twilio.sms.<CC>` and `twilio.mms.<CC>` per
 * segment / message (country price plus US carrier fees), `twilio.verify.<channel>[.<CC>]` per
 * verification attempt (base fee plus the channel's delivery fee).
 */
export function loadTwilioPrices(): Map<string, bigint> {
  const sms = smsSchema.parse(parse(readDataFile('twilio/sms.yaml')));
  const verify = verifySchema.parse(parse(readDataFile('twilio/verify.yaml')));
  const prices = new Map<string, bigint>();
  const carrier = (cc: string, kind: 'sms' | 'mms') =>
    cc === 'US' ? parseUsd(sms.usCarrierFees[kind]) : 0n;
  for (const [cc, c] of Object.entries(sms.countries))
    prices.set(`twilio.sms.${cc}`, parseUsd(c.sms) + carrier(cc, 'sms'));
  for (const [cc, p] of Object.entries(sms.mms))
    prices.set(`twilio.mms.${cc}`, parseUsd(p) + carrier(cc, 'mms'));
  const base = parseUsd(verify.baseFee);
  for (const [channel, ch] of Object.entries(verify.channels)) {
    if (ch.fee === null) continue;
    if (ch.fee === 'sms') {
      for (const cc of Object.keys(sms.countries)) {
        prices.set(`twilio.verify.sms.${cc}`, base + prices.get(`twilio.sms.${cc}`)!);
      }
    } else if (ch.countries) {
      for (const cc of ch.countries)
        prices.set(`twilio.verify.${channel}.${cc}`, base + parseUsd(ch.fee));
    } else {
      prices.set(`twilio.verify.${channel}`, base + parseUsd(ch.fee));
    }
  }
  return prices;
}

const MESSAGES = /^\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Messages\.json$/;
const VERIFICATIONS = /^\/v2\/Services\/VA[0-9a-f]{32}\/Verifications$/;
const VERIFICATION_CHECK = /^\/v2\/Services\/VA[0-9a-f]{32}\/VerificationCheck$/;

type Form = Record<string, string | string[] | undefined>;
const field = (b: Form, k: string) => {
  const v = b[k];
  return Array.isArray(v) ? v[0] : v;
};

/** Destination country and the prefix pumping is counted on (country code + 3 digits). */
export function destination(to: string): {
  number: string;
  country: string | null;
  prefix: string;
} {
  const phone = parsePhoneNumberFromString(to);
  const digits = to.replace(/\D/g, '');
  const country = phone?.isValid() ? (phone.country ?? null) : null;
  const cc = phone?.countryCallingCode ?? '';
  const national = phone?.nationalNumber ?? digits;
  return { number: `+${digits}`, country, prefix: `+${cc}${national.slice(0, 3)}` };
}

/** Twilio Messaging and Verify. Requests are form-encoded; the real Auth Token is injected. */
/** Decimal dollars with any number of decimals to micros, rounding up past the sixth. */
function decimalMicrosUp(value: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid Twilio price ${JSON.stringify(value)}`);
  const frac = m[2] ?? '';
  const micros = parseUsd(`${m[1]}.${frac.slice(0, 6).padEnd(6, '0')}`);
  return /[1-9]/.test(frac.slice(6)) ? micros + 1n : micros;
}

export class TwilioAdapter implements ProviderAdapter {
  readonly id = TWILIO;
  readonly upstreams = [
    { prefix: '/twilio', origin: API },
    { prefix: '/twilio-verify', origin: VERIFY },
  ] as const;
  readonly timeoutBilled = true;
  readonly prices: Map<string, bigint>;
  private readonly carrierFees: { sms: bigint; mms: bigint };

  constructor(prices = loadTwilioPrices()) {
    this.prices = prices;
    const sms = smsSchema.parse(parse(readDataFile('twilio/sms.yaml')));
    this.carrierFees = {
      sms: parseUsd(sms.usCarrierFees.sms),
      mms: parseUsd(sms.usCarrierFees.mms),
    };
  }

  match(req: IncomingReq): boolean {
    return this.upstreams.some((u) => u.origin === req.origin);
  }

  classify(req: IncomingReq): Classified {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Form;
    const hash = normalizedHash({
      method: req.method,
      origin: req.origin,
      path: req.path,
      query: req.query,
      body,
    });
    const unpriced = (reason: string): Classified => ({
      priced: false,
      provider: this.id,
      reason,
      normalizedHash: hash,
    });
    const method = req.method.toUpperCase();
    const priced = (route: string, sku: string, units: bigint, to: string): Classified => {
      if (!this.prices.has(sku)) return unpriced(`no verified price for ${sku}`);
      return {
        priced: true,
        provider: this.id,
        route,
        items: [{ sku, units }],
        normalizedHash: hash,
        destination: destination(to),
      };
    };

    if (method === 'POST' && req.origin === API && MESSAGES.test(req.path)) {
      const to = field(body, 'To') ?? '';
      if (!to || to.includes(':')) return unpriced('only SMS/MMS to phone numbers is priced');
      const dest = destination(to);
      if (!dest.country) return unpriced('destination number has no known country');
      if (body.MediaUrl !== undefined || body.ContentSid !== undefined) {
        return priced('twilio.mms', `twilio.mms.${dest.country}`, 1n, to);
      }
      const text = field(body, 'Body');
      if (text === undefined) return unpriced('message without Body');
      return priced(
        'twilio.sms',
        `twilio.sms.${dest.country}`,
        BigInt(countSegments(text).segments),
        to,
      );
    }
    if (method === 'POST' && req.origin === VERIFY && VERIFICATIONS.test(req.path)) {
      const to = field(body, 'To') ?? '';
      const channel = field(body, 'Channel') ?? 'sms';
      if (channel === 'email') return priced('twilio.verify', 'twilio.verify.email', 1n, to);
      const dest = destination(to);
      if (!dest.country) return unpriced('destination number has no known country');
      return priced('twilio.verify', `twilio.verify.${channel}.${dest.country}`, 1n, to);
    }
    if (method === 'POST' && req.origin === VERIFY && VERIFICATION_CHECK.test(req.path)) {
      // The base fee is reserved with the verification itself; checking costs nothing more.
      return {
        priced: true,
        provider: this.id,
        route: 'twilio.verify_check',
        items: [],
        normalizedHash: hash,
      };
    }
    return unpriced(`no catalog entry for ${method} ${req.origin}${req.path}`);
  }

  billingSession(): null {
    return null;
  }

  /** Sends are buffered to read the message and account SIDs for later settlement. */
  needsBody(c: PricedClassified): boolean {
    return c.route === 'twilio.sms' || c.route === 'twilio.mms';
  }

  pendingSettlement(c: PricedClassified, res: UpstreamRes): Record<string, string> | null {
    if (!this.needsBody(c) || !this.billedOnStatus(res.status)) return null;
    const body = res.body as { sid?: unknown; account_sid?: unknown } | undefined;
    if (typeof body?.sid !== 'string' || typeof body.account_sid !== 'string') return null;
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(body.sid) || !/^AC[0-9a-f]{32}$/.test(body.account_sid))
      return null;
    const item = c.items[0]!;
    return {
      accountSid: body.account_sid,
      sid: body.sid,
      sku: item.sku,
      units: item.units.toString(),
    };
  }

  /**
   * The final cost of a sent message from its Message resource: Twilio's `price` (negative, in
   * `price_unit`) plus, for US numbers, the carrier pass-through fee Twilio bills separately.
   * Null while Twilio has not priced it yet.
   */
  settledPrice(
    ref: Record<string, string>,
    resource: { price?: unknown; price_unit?: unknown; num_segments?: unknown },
  ): bigint | null {
    if (typeof resource.price !== 'string' || resource.price === '') return null;
    // Twilio documents the unit in lower case (`usd`) and returns it in upper case.
    if (String(resource.price_unit).toUpperCase() !== 'USD')
      throw new Error(`Twilio price in ${String(resource.price_unit)}; only USD is supported`);
    const price = decimalMicrosUp(resource.price.replace(/^-/, ''));
    const sku = ref.sku ?? '';
    // 0 segments while a Messaging Service has not picked a sender yet: keep the counted ones.
    const reported = /^\d+$/.test(String(resource.num_segments))
      ? BigInt(String(resource.num_segments))
      : 0n;
    const segments = reported > 0n ? reported : BigInt(ref.units ?? '1');
    let carrier = 0n;
    if (sku === 'twilio.sms.US') carrier = this.carrierFees.sms * segments;
    if (sku === 'twilio.mms.US') carrier = this.carrierFees.mms;
    return price + carrier;
  }

  worstCase(c: PricedClassified): bigint {
    return c.items.reduce((sum, i) => sum + this.prices.get(i.sku)! * i.units, 0n);
  }

  /** Billed on creation (Twilio charges sent and undelivered messages alike). */
  actual(c: PricedClassified, res: UpstreamRes): bigint {
    return this.billedOnStatus(res.status) ? this.worstCase(c) : 0n;
  }

  /** Secret is `<AccountSid>:<AuthToken>` (or an API key `SK…:<secret>`), sent as Basic auth. */
  injectCredential(req: OutgoingReq, secret: string): void {
    req.headers.authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }

  credentialRejected(res: UpstreamRes): boolean {
    const code = (res.body as { code?: unknown } | undefined)?.code;
    return res.status === 401 || res.status === 403 || code === 20003;
  }
}
