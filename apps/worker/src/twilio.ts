import type { BudgetEngine} from '@spend-brake/budget';
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
import type { Alert } from './alerts.js';
import { DRIFT_ALERT_RATIO, DRIFT_MIN_BILLED_MICROS } from './reconcile.js';

const API = 'https://api.twilio.com/2010-04-01';
const SETTLE_GIVE_UP_MS = 48 * 3600_000;
const RECHECK_MS = 10 * 60_000;

export interface TwilioDeps {
  db: Db;
  engine: BudgetEngine;
  registry: Registry;
  wrapper: KeyWrapper;
  fetch: typeof fetch;
  now: () => Date;
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
 * Messages Twilio has not priced within 48 hours keep the worst case.
 */
export async function settleTwilioPending(
  deps: TwilioDeps,
  orgIds: readonly string[],
): Promise<SettleResult> {
  const adapter = new TwilioAdapter();
  const out: SettleResult = { settled: 0, deferred: 0, expired: 0 };
  for (const orgId of orgIds) {
    for (const { reqId, record } of await deps.engine.duePending(orgId, deps.now())) {
      if (record.provider !== 'twilio') continue;
      const ref = record.ref;
      const age = deps.now().getTime() - Date.parse(record.at);
      if (age > SETTLE_GIVE_UP_MS) {
        if (await deps.engine.takePending(orgId, reqId)) out.expired++;
        continue;
      }
      if (
        !/^AC[0-9a-f]{32}$/.test(ref.accountSid ?? '') ||
        !/^(SM|MM)[0-9a-f]{32}$/.test(ref.sid ?? '')
      ) {
        await deps.engine.takePending(orgId, reqId);
        continue;
      }
      let price: bigint | null;
      try {
        const cred = await deps.registry.getCredential(orgId, record.credentialId);
        if (!cred) throw new Error('credential gone');
        const secret = await decryptSecret(
          deps.wrapper,
          cred.envelope as Envelope,
          credentialContext(orgId, cred.id),
        );
        const message = await twilioJson(
          deps,
          secret,
          `/Accounts/${ref.accountSid}/Messages/${ref.sid}.json`,
        );
        price = adapter.settledPrice(ref, message as Record<string, unknown>);
      } catch {
        price = null;
      }
      if (price === null) {
        await deps.engine.deferPending(orgId, reqId, new Date(deps.now().getTime() + RECHECK_MS));
        out.deferred++;
        continue;
      }
      if (!(await deps.engine.takePending(orgId, reqId))) continue;
      const committed = BigInt(record.committedMicros);
      const delta = price - committed;
      await deps.engine.adjustSpend({
        orgId,
        delta,
        scopes: record.scopes.map(parseScopeLabel),
        timeZone: record.timeZone,
        at: new Date(record.at),
        event: {
          type: 'adjustment',
          reqId,
          keyId: record.keyId,
          provider: 'twilio',
          skus: ref.sku ?? '',
          costMicros: delta.toString(),
          fromMicros: committed.toString(),
          toMicros: price.toString(),
          ref: ref.sid ?? '',
          // The send's own time: reconciliation counts the adjustment on the day of the send.
          usageAt: record.at,
        },
      });
      out.settled++;
    }
  }
  return out;
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
    for (let i = 1; i <= days; i++) {
      const start = new Date(
        Date.UTC(
          deps.now().getUTCFullYear(),
          deps.now().getUTCMonth(),
          deps.now().getUTCDate() - i,
        ),
      );
      const end = new Date(start.getTime() + 86_400_000);
      const day = start.toISOString().slice(0, 10);
      for (const [family, categories] of Object.entries(CATEGORIES)) {
        let billed = 0n;
        for (const c of list) {
          const secret = await decryptSecret(
            deps.wrapper,
            c.envelope as Envelope,
            credentialContext(orgId, c.id),
          );
          const account = secret.split(':')[0] ?? '';
          if (!/^AC[0-9a-f]{32}$/.test(account)) continue;
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
        if (billed >= DRIFT_MIN_BILLED_MICROS && ratio !== null && ratio > DRIFT_ALERT_RATIO) {
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
  }
  return alerts;
}
