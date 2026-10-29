import { type Catalog, googleSkuIndex, skuFamily } from '@spend-brake/catalog';
import { windowResetsAt } from '@spend-brake/budget';
import {
  type Db,
  and,
  eq,
  gte,
  lt,
  reconciliationConfigs,
  reconciliationResults,
  sql,
  usageEvents,
} from '@spend-brake/db';
import type { Alert } from './alerts.js';

export interface BillingRow {
  skuId: string;
  currency: string;
  costMicros: bigint;
}

/** Google's billed cost per SKU in a time range, from the Cloud Billing export. */
export interface BillingSource {
  costs(q: {
    start: Date;
    end: Date;
    skuIds: string[];
    projectIds: string[];
  }): Promise<BillingRow[]>;
}

const TABLE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

export function validExportTable(table: string): boolean {
  return TABLE.test(table);
}

/**
 * Billed cost per SKU. `cost` is the gross cost before credits, as the ledger prices list cost.
 * The sum is turned into integer micros inside BigQuery, so no float reaches us.
 */
export function billingQuery(table: string): string {
  if (!validExportTable(table)) throw new Error('invalid export table');
  return `SELECT sku.id AS sku_id, currency,
  CAST(ROUND(SUM(cost) * 1000000) AS INT64) AS cost_micros
FROM \`${table}\`
WHERE usage_start_time >= @start AND usage_start_time < @end
  AND sku.id IN UNNEST(@sku_ids)
  AND (ARRAY_LENGTH(@project_ids) = 0 OR project.id IN UNNEST(@project_ids))
GROUP BY sku_id, currency`;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Read-only BigQuery access with the org's service account (Billing export viewer). */
export async function bigQuerySource(
  table: string,
  serviceAccountJson: string,
): Promise<BillingSource> {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const { BigQuery } = await import('@google-cloud/bigquery');
  const bq = new BigQuery({
    projectId: sa.project_id,
    credentials: { client_email: sa.client_email, private_key: sa.private_key },
  });
  const query = billingQuery(table);
  return {
    async costs(q) {
      const [rows] = await bq.query({
        query,
        params: { start: q.start, end: q.end, sku_ids: q.skuIds, project_ids: q.projectIds },
        types: { sku_ids: ['STRING'], project_ids: ['STRING'] },
      });
      return (rows as { sku_id: string; currency: string; cost_micros: number | string }[]).map(
        (r) => ({
          skuId: r.sku_id,
          currency: r.currency,
          costMicros: BigInt(r.cost_micros),
        }),
      );
    },
  };
}

/** Drift above this share of the billed amount raises an alert. */
export const DRIFT_ALERT_RATIO = 0.05;
/** Days billed below this are too small to judge drift on. */
export const DRIFT_MIN_BILLED_MICROS = 1_000_000n;

export interface FamilyResult {
  family: string;
  ledgerMicros: bigint;
  billedMicros: bigint;
  driftRatio: number | null;
}

export interface DayResult {
  day: string;
  total: FamilyResult;
  families: FamilyResult[];
  alert: Alert | null;
}

const ratio = (ledger: bigint, billed: bigint): number | null =>
  billed === 0n
    ? null
    : Number(((ledger > billed ? ledger - billed : billed - ledger) * 1_000_000n) / billed) /
      1_000_000;

/** UTC bounds of one billing day (`YYYY-MM-DD`) in the provider's billing time zone. */
export function billingDay(day: string, timeZone: string): { start: Date; end: Date } {
  const noon = new Date(`${day}T12:00:00Z`);
  return {
    start: windowResetsAt('d', new Date(noon.getTime() - 86_400_000), timeZone),
    end: windowResetsAt('d', noon, timeZone),
  };
}

/** Compare one org's ledger with Google's bill for one billing day and store the result. */
export async function reconcileDay(
  db: Db,
  source: BillingSource,
  catalog: Catalog,
  cfg: { orgId: string; projectIds: string[] },
  day: string,
  now = new Date(),
): Promise<DayResult> {
  const { start, end } = billingDay(day, catalog.billingTimeZone);
  const index = googleSkuIndex(catalog);

  const ledger = await db
    .select({
      sku: usageEvents.sku,
      cost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::text`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, cfg.orgId),
        eq(usageEvents.type, 'usage'),
        eq(usageEvents.provider, catalog.provider),
        gte(usageEvents.ts, start),
        lt(usageEvents.ts, end),
      ),
    )
    .groupBy(usageEvents.sku);

  const billed = await source.costs({
    start,
    end,
    skuIds: [...index.keys()],
    projectIds: cfg.projectIds,
  });
  const other = billed.find((b) => b.currency !== 'USD');
  if (other) throw new Error(`billing export is in ${other.currency}; only USD is supported`);

  const families = new Map<string, { ledger: bigint; billed: bigint }>();
  const add = (family: string, key: 'ledger' | 'billed', v: bigint) => {
    const f = families.get(family) ?? { ledger: 0n, billed: 0n };
    f[key] += v;
    families.set(family, f);
  };
  for (const r of ledger) if (r.sku) add(skuFamily(r.sku), 'ledger', BigInt(r.cost));
  for (const b of billed) {
    const sku = index.get(b.skuId);
    if (sku) add(skuFamily(sku), 'billed', b.costMicros);
  }

  const results: FamilyResult[] = [...families.entries()]
    .map(([family, v]) => ({
      family,
      ledgerMicros: v.ledger,
      billedMicros: v.billed,
      driftRatio: ratio(v.ledger, v.billed),
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
  const totalLedger = results.reduce((a, r) => a + r.ledgerMicros, 0n);
  const totalBilled = results.reduce((a, r) => a + r.billedMicros, 0n);
  const total: FamilyResult = {
    family: 'total',
    ledgerMicros: totalLedger,
    billedMicros: totalBilled,
    driftRatio: ratio(totalLedger, totalBilled),
  };

  for (const r of [...results, total]) {
    const row = {
      orgId: cfg.orgId,
      day,
      family: r.family,
      ledgerMicros: r.ledgerMicros,
      billedMicros: r.billedMicros,
      driftRatio: r.driftRatio,
      computedAt: now,
    };
    await db
      .insert(reconciliationResults)
      .values(row)
      .onConflictDoUpdate({
        target: [
          reconciliationResults.orgId,
          reconciliationResults.day,
          reconciliationResults.family,
        ],
        set: row,
      });
  }

  const drifting =
    totalBilled >= DRIFT_MIN_BILLED_MICROS &&
    total.driftRatio !== null &&
    total.driftRatio > DRIFT_ALERT_RATIO;
  const alert: Alert | null = drifting
    ? {
        type: 'reconcile_drift',
        orgId: cfg.orgId,
        dedupeId: `reconcile:${cfg.orgId}:${day}`,
        data: {
          day,
          ledgerMicros: totalLedger.toString(),
          billedMicros: totalBilled.toString(),
          ratio: total.driftRatio,
          families: results
            .filter((r) => r.driftRatio === null || r.driftRatio > DRIFT_ALERT_RATIO)
            .map((r) => ({
              family: r.family,
              ledgerMicros: r.ledgerMicros.toString(),
              billedMicros: r.billedMicros.toString(),
            })),
        },
      }
    : null;
  return { day, total, families: results, alert };
}

/** The billing days to (re)check: the export lags, so the last three completed days. */
export function daysToCheck(now: Date, timeZone: string, count = 3): string[] {
  const days: string[] = [];
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (let i = 1; i <= count; i++) days.push(fmt.format(new Date(now.getTime() - i * 86_400_000)));
  return days;
}

export async function markRun(
  db: Db,
  orgId: string,
  now: Date,
  error: string | null,
): Promise<void> {
  await db
    .update(reconciliationConfigs)
    .set({ lastRunAt: now, lastError: error })
    .where(eq(reconciliationConfigs.orgId, orgId));
}
