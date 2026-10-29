import type { BudgetEngine, PendingSettlement } from '@spend-brake/budget';
import { type Registry, parseScopeLabel } from '@spend-brake/budget';
import { TwilioAdapter } from '@spend-brake/catalog';
import {
  type Db,
  and,
  eq,
  gte,
  isNull,
  like,
  lt,
  providerCredentials,
  reconciliationResults,
  sql,
  usageEvents,
} from '@spend-brake/db';
import {
  type Envelope,
  type KeyWrapper,
  credentialContext,
  decryptSecret,
} from '@spend-brake/shared';
import type { Redis } from 'ioredis';
import type { Alert } from './alerts.js';
import { DRIFT_ALERT_RATIO, DRIFT_MIN_BILLED_MICROS } from './reconcile.js';

const API = 'https://api.twilio.com/2010-04-01';
const SETTLE_GIVE_UP_MS = 48 * 3600_000;
const RECHECK_MS = 10 * 60_000;
// Session windows live 48 h; leave them alone a little before that.
const SESSION_ADJUST_MS = 47 * 3600_000;
const BATCH = 200;
const MAX_BATCHES = 10;
const CONCURRENCY = 8;

/** Valkey key remembering the Twilio account a credential sends from (API keys do not say). */
const accountKey = (orgId: string, credentialId: string) =>
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

async function twilioJson(deps: TwilioDeps, secret: string, path: string): Promise<unknown> {
  const res = await deps.fetch(`${API}${path}`, {
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

// Usage Records categories that make up outbound SMS / MMS cost, carrier fees included.
const CATEGORIES = {
  'twilio.sms': ['sms-outbound', 'sms-messages-carrierfees'],
  'twilio.mms': ['mms-outbound', 'mms-messages-carrierfees'],
} as const;

/**
 * Compare the ledger (sends plus settlement adjustments) with Twilio's Usage Records per UTC day
 * for the last three days; results go next to the Google ones, drift above 5% alerts.
 */
export async function reconcileTwilio(deps: TwilioDeps, days = 3): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const creds = await deps.db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.provider, 'twilio'), isNull(providerCredentials.revokedAt)));
  const byOrg = new Map<string, typeof creds>();
  for (const c of creds) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c]);

  for (const [orgId, list] of byOrg) {
    try {
      alerts.push(...(await reconcileOrg(deps, orgId, list, days)));
    } catch (err) {
      // One revoked token or odd response must not stop the other orgs.
      deps.log?.warn({ orgId, err: (err as Error).message }, 'twilio reconciliation failed');
    }
  }
  return alerts;
}

type CredentialRow = typeof providerCredentials.$inferSelect;

async function reconcileOrg(
  deps: TwilioDeps,
  orgId: string,
  list: CredentialRow[],
  days: number,
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  // One secret per Twilio account: two credentials for the same account (a rotation) would
  // count its usage twice. API keys (SK…) name no account; settlement records the one they
  // sent from.
  const accounts = new Map<string, string>();
  for (const c of list) {
    const secret = await decryptSecret(
      deps.wrapper,
      c.envelope as Envelope,
      credentialContext(orgId, c.id),
    );
    const prefix = secret.split(':')[0] ?? '';
    const account = /^AC[0-9a-f]{32}$/.test(prefix)
      ? prefix
      : await deps.valkey.get(accountKey(orgId, c.id));
    if (!account || !/^AC[0-9a-f]{32}$/.test(account)) {
      deps.log?.warn(
        { orgId, credentialId: c.id },
        'twilio credential has no known account yet; skipped in reconciliation',
      );
      continue;
    }
    if (!accounts.has(account)) accounts.set(account, secret);
  }
  if (accounts.size === 0) return alerts;
  for (let i = 1; i <= days; i++) {
    const start = new Date(
      Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), deps.now().getUTCDate() - i),
    );
    const end = new Date(start.getTime() + 86_400_000);
    const day = start.toISOString().slice(0, 10);
    for (const [family, categories] of Object.entries(CATEGORIES)) {
      let billed = 0n;
      for (const [account, secret] of accounts) {
        for (const category of categories) {
          const q = new URLSearchParams({ Category: category, StartDate: day, EndDate: day });
          const body = (await twilioJson(
            deps,
            secret,
            `/Accounts/${account}/Usage/Records/Daily.json?${q.toString()}`,
          )) as {
            usage_records?: { price?: string; price_unit?: string }[];
          };
          for (const r of body.usage_records ?? []) {
            if (!r.price) continue;
            if (r.price_unit && r.price_unit.toUpperCase() !== 'USD')
              throw new Error(`Twilio usage in ${r.price_unit}`);
            billed += usdMicros(r.price);
          }
        }
      }
      const [row] = await deps.db
        .select({ cost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::text` })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.orgId, orgId),
            eq(usageEvents.provider, 'twilio'),
            sql`${usageEvents.type} in ('usage', 'adjustment')`,
            like(usageEvents.skus, `${family}.%`),
            sql`coalesce((${usageEvents.data}->>'usageAt')::timestamptz, ${usageEvents.ts}) >= ${start.toISOString()}::timestamptz`,
            sql`coalesce((${usageEvents.data}->>'usageAt')::timestamptz, ${usageEvents.ts}) < ${end.toISOString()}::timestamptz`,
            // Adjustments land up to 48 h after the send.
            gte(usageEvents.ts, start),
            lt(usageEvents.ts, new Date(end.getTime() + SETTLE_GIVE_UP_MS + 86_400_000)),
          ),
        );
      const ledger = BigInt(row?.cost ?? '0');
      const diff = ledger > billed ? ledger - billed : billed - ledger;
      const ratio = billed === 0n ? null : Number((diff * 1_000_000n) / billed) / 1_000_000;
      const result = {
        orgId,
        day,
        family,
        ledgerMicros: ledger,
        billedMicros: billed,
        driftRatio: ratio,
        computedAt: deps.now(),
      };
      await deps.db
        .insert(reconciliationResults)
        .values(result)
        .onConflictDoUpdate({
          target: [
            reconciliationResults.orgId,
            reconciliationResults.day,
            reconciliationResults.family,
          ],
          set: result,
        });
      // Yesterday's sends may still be settling (up to 48 h): recorded, alerted from day 2.
      if (
        i >= 2 &&
        billed >= DRIFT_MIN_BILLED_MICROS &&
        ratio !== null &&
        ratio > DRIFT_ALERT_RATIO
      ) {
        alerts.push({
          type: 'reconcile_drift',
          orgId,
          dedupeId: `reconcile:${orgId}:${day}:${family}`,
          data: {
            day,
            family,
            ledgerMicros: ledger.toString(),
            billedMicros: billed.toString(),
            ratio,
          },
        });
      }
    }
  }
  return alerts;
}
