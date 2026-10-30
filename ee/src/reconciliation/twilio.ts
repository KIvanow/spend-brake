import {
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
import { type Envelope, credentialContext, decryptSecret } from '@spend-brake/shared';
import {
  type Alert,
  SETTLE_GIVE_UP_MS,
  type TwilioDeps,
  accountKey,
  twilioJson,
  usdMicros,
} from '@spend-brake/worker';
import { DRIFT_ALERT_RATIO, DRIFT_MIN_BILLED_MICROS } from './google.js';

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
