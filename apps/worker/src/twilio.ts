import type { BudgetEngine, PendingSettlement } from '@spend-brake/budget';
import { type Registry, parseScopeLabel } from '@spend-brake/budget';
import { TwilioAdapter } from '@spend-brake/catalog';
import type { Db } from '@spend-brake/db';
import {
  type Envelope,
  type KeyWrapper,
  credentialContext,
  decryptSecret,
} from '@spend-brake/shared';
import type { ValkeyClient as Redis } from '@spend-brake/budget';

export const TWILIO_API = 'https://api.twilio.com/2010-04-01';
export const SETTLE_GIVE_UP_MS = 48 * 3600_000;
const RECHECK_MS = 10 * 60_000;
// Session windows live 48 h; leave them alone a little before that.
const SESSION_ADJUST_MS = 47 * 3600_000;
const BATCH = 200;
const MAX_BATCHES = 10;
const CONCURRENCY = 8;

/** Valkey key remembering the Twilio account a credential sends from (API keys do not say). */
export const accountKey = (orgId: string, credentialId: string) =>
  `bk:{o:${orgId}}:twilio-account:${credentialId}`;

export interface TwilioDeps {
  db: Db;
  engine: BudgetEngine;
  registry: Registry;
  wrapper: KeyWrapper;
  valkey: Redis;
  fetch: typeof fetch;
  now: () => Date;
  log?: { warn(obj: object, msg: string): void };
}

/** Exact decimal dollars ("12.3456789") to micros, rounding the seventh decimal half up. */
export function usdMicros(value: string): bigint {
  const m = /^-?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`bad Twilio price ${value}`);
  const frac = (m[2] ?? '').padEnd(7, '0');
  const micros =
    BigInt(m[1]!) * 1_000_000n + BigInt(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1n : 0n);
  return value.trim().startsWith('-') ? -micros : micros;
}

const auth = (secret: string) => `Basic ${Buffer.from(secret).toString('base64')}`;

export async function twilioJson(deps: TwilioDeps, secret: string, path: string): Promise<unknown> {
  const res = await deps.fetch(`${TWILIO_API}${path}`, {
    headers: { authorization: auth(secret) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new Error(
      `Twilio ${path.split('?')[0]?.replace(/AC[0-9a-f]{32}/, 'AC…')}: HTTP ${res.status}`,
    );
  return res.json();
}

export interface SettleResult {
  settled: number;
  deferred: number;
  expired: number;
}

/**
 * Settle Twilio sends at their final price: the proxy committed the worst case and queued the
 * message; once Twilio has priced it, move the spend by the difference in the original windows.
 * Failed and canceled messages are free. Messages Twilio has not priced within 48 hours keep the
 * worst case. One bad record never stops the others.
 */
export async function settleTwilioPending(
  deps: TwilioDeps,
  orgIds: readonly string[],
): Promise<SettleResult> {
  const adapter = new TwilioAdapter();
  const out: SettleResult = { settled: 0, deferred: 0, expired: 0 };
  for (const orgId of orgIds) {
    // Drain the due queue in batches; deferred records move out of the due range.
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const due = await deps.engine.duePending(orgId, deps.now(), BATCH);
      for (let i = 0; i < due.length; i += CONCURRENCY) {
        await Promise.all(
          due.slice(i, i + CONCURRENCY).map(async ({ reqId, record }) => {
            try {
              const r = await settleOne(deps, adapter, orgId, reqId, record);
              if (r) out[r]++;
            } catch (err) {
              deps.log?.warn({ orgId, reqId, err: (err as Error).message }, 'twilio settle failed');
            }
          }),
        );
      }
      if (due.length < BATCH) break;
    }
  }
  return out;
}

const TERMINAL_UNBILLED = new Set(['failed', 'canceled']);

async function settleOne(
  deps: TwilioDeps,
  adapter: TwilioAdapter,
  orgId: string,
  reqId: string,
  record: PendingSettlement,
): Promise<keyof SettleResult | null> {
  const ref = record.ref;
  const age = deps.now().getTime() - Date.parse(record.at);
  if (
    record.provider !== 'twilio' ||
    !/^AC[0-9a-f]{32}$/.test(ref.accountSid ?? '') ||
    !/^(SM|MM)[0-9a-f]{32}$/.test(ref.sid ?? '') ||
    !Number.isFinite(age)
  ) {
    // Not ours to settle or malformed: drop it, the worst case stays committed.
    await deps.engine.takePending(orgId, reqId);
    return null;
  }
  if (age > SETTLE_GIVE_UP_MS) {
    return (await deps.engine.takePending(orgId, reqId)) ? 'expired' : null;
  }
  let price: bigint | null = null;
  try {
    const cred = await deps.registry.getCredential(orgId, record.credentialId);
    if (!cred) throw new Error('credential gone');
    const secret = await decryptSecret(
      deps.wrapper,
      cred.envelope as Envelope,
      credentialContext(orgId, cred.id),
    );
    const message = (await twilioJson(
      deps,
      secret,
      `/Accounts/${ref.accountSid}/Messages/${ref.sid}.json`,
    )) as Record<string, unknown>;
    // The account behind this credential, for reconciling API-key credentials.
    await deps.valkey.set(accountKey(orgId, record.credentialId), ref.accountSid!);
    price = adapter.settledPrice(ref, message);
    if (price === null && TERMINAL_UNBILLED.has(String(message.status))) price = 0n;
  } catch (err) {
    deps.log?.warn({ orgId, reqId, err: (err as Error).message }, 'twilio price lookup failed');
  }
  if (price === null) {
    await deps.engine.deferPending(orgId, reqId, new Date(deps.now().getTime() + RECHECK_MS));
    return 'deferred';
  }
  if (!(await deps.engine.takePending(orgId, reqId))) return null;
  const committed = BigInt(record.committedMicros);
  const delta = price - committed;
  // Session windows expire after 48 h; adjusting one after that would leave a negative counter.
  const scopes = record.scopes
    .map(parseScopeLabel)
    .filter((sc) => sc.kind !== 'sess' || age < SESSION_ADJUST_MS);
  await deps.engine.adjustSpend({
    orgId,
    delta,
    scopes,
    timeZone: record.timeZone,
    at: new Date(record.at),
    event: {
      type: 'adjustment',
      reqId,
      keyId: record.keyId,
      provider: 'twilio',
      route: ref.sku?.startsWith('twilio.mms') ? 'twilio.mms' : 'twilio.sms',
      skus: ref.sku ?? '',
      costMicros: delta.toString(),
      worstMicros: committed.toString(),
      fromMicros: committed.toString(),
      toMicros: price.toString(),
      // Twilio charged more than the catalog's worst case: the price data is stale.
      ...(delta > 0n ? { underpriced: '1' } : {}),
      ref: ref.sid ?? '',
      // The send's own time: reconciliation counts the adjustment on the day of the send.
      usageAt: record.at,
    },
  });
  return 'settled';
}
