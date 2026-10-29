import { parse } from 'yaml';
import { z } from 'zod';
import { readDataFile } from './catalog.js';
import { parseUsd } from './pricing.js';

const usd = z.string().regex(/^\d+(\.\d{1,6})?$/);

const providerSchema = z.strictObject({
  name: z.string(),
  source: z.url(),
  creditsSource: z.url().optional(),
  quota: z.enum(['daily', 'monthly']),
  plans: z
    .array(
      z.strictObject({
        name: z.string(),
        usdPerMonth: usd,
        credits: z.number().int().positive(),
        overagePer1000: usd.nullable().optional(),
        commercial: z.boolean().optional(),
      }),
    )
    .min(1),
  overPlans: z.string().optional(),
  credits: z.record(
    z.string(),
    z.strictObject({ perUnit: z.number().positive(), note: z.string().optional() }),
  ),
});

const fileSchema = z.strictObject({
  verifiedAt: z.string(),
  providers: z.record(z.string(), providerSchema),
});

export type Alternatives = z.output<typeof fileSchema>;

export function loadAlternatives(): Alternatives {
  return fileSchema.parse(parse(readDataFile('migration/alternatives.yaml')));
}

/** Billed usage of one SKU on one day (from the ledger). */
export interface UsageRow {
  sku: string;
  day: string;
  requests: number;
  units: number;
  costMicros: bigint;
}

/** Catalog SKUs differ by tier (`places.text_search.pro`); alternatives price the endpoint. */
export function endpointOf(sku: string): string {
  return sku.replace(/\.(ids_only|essentials|pro|enterprise|enterprise_atmosphere)$/, '');
}

export interface Uncovered {
  sku: string;
  requests: number;
  googleCostMicros: number;
}

export interface Estimate {
  provider: string;
  name: string;
  source: string;
  /** Cheapest plan that covers the usage; null when it needs a custom contract. */
  plan: string | null;
  monthlyCostMicros: number | null;
  credits: number;
  /** Peak day for daily quotas, the whole period for monthly ones. */
  creditsCompared: number;
  coveredGoogleCostMicros: number;
  uncovered: Uncovered[];
  /** Google spend that stays on Google because this provider has no equivalent. */
  uncoveredGoogleCostMicros: number;
  /** Covered work moved here plus uncovered work left on Google. */
  totalMicros: number | null;
  notes: string[];
}

export interface MigrationEstimate {
  periodDays: number;
  googleCostMicros: number;
  requests: number;
  bySku: { sku: string; requests: number; units: number; costMicros: number }[];
  alternatives: Estimate[];
  verifiedAt: string;
}

/**
 * Price the same usage on each alternative: credits per mapped SKU, the cheapest plan whose
 * quota (or quota plus overage) fits, and what stays on Google because the provider lacks it.
 * Monthly figures assume the period is a month.
 */
export function estimateMigration(
  rows: readonly UsageRow[],
  alts: Alternatives,
  periodDays = 30,
): MigrationEstimate {
  const bySku = new Map<string, { requests: number; units: number; cost: bigint }>();
  for (const r of rows) {
    const s = bySku.get(r.sku) ?? { requests: 0, units: 0, cost: 0n };
    s.requests += r.requests;
    s.units += r.units;
    s.cost += r.costMicros;
    bySku.set(r.sku, s);
  }
  const googleCost = [...bySku.values()].reduce((a, s) => a + s.cost, 0n);

  const alternatives = Object.entries(alts.providers).map(([id, p]): Estimate => {
    const perDay = new Map<string, number>();
    let credits = 0;
    let covered = 0n;
    const uncovered = new Map<string, Uncovered>();
    const notes = new Set<string>();
    for (const r of rows) {
      const map = p.credits[endpointOf(r.sku)];
      if (!map) {
        const u = uncovered.get(r.sku) ?? { sku: r.sku, requests: 0, googleCostMicros: 0 };
        u.requests += r.requests;
        u.googleCostMicros += Number(r.costMicros);
        uncovered.set(r.sku, u);
        continue;
      }
      const c = Math.ceil(r.units * map.perUnit);
      credits += c;
      covered += r.costMicros;
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + c);
      if (map.note) notes.add(`${endpointOf(r.sku)}: ${map.note}`);
    }
    const compared = p.quota === 'daily' ? Math.max(0, ...perDay.values()) : credits;

    let best: { plan: string; cost: bigint } | null = null;
    for (const plan of p.plans) {
      const base = parseUsd(plan.usdPerMonth);
      let cost: bigint | null = null;
      if (compared <= plan.credits) cost = base;
      else if (plan.overagePer1000) {
        const extra = BigInt(compared - plan.credits);
        cost = base + (extra * parseUsd(plan.overagePer1000) + 999n) / 1000n;
      }
      if (cost !== null && plan.commercial === false) {
        notes.add(`${plan.name} plan: commercial use not allowed`);
        if (credits > 0) continue;
      }
      if (cost !== null && (!best || cost < best.cost)) best = { plan: plan.name, cost };
    }
    if (!best && p.overPlans) notes.add(`usage exceeds listed plans: ${p.overPlans}`);
    if (p.quota === 'daily') notes.add('quota is per day; compared against the busiest day');

    const uncoveredList = [...uncovered.values()].sort(
      (a, b) => b.googleCostMicros - a.googleCostMicros,
    );
    const uncoveredCost = uncoveredList.reduce((a, u) => a + u.googleCostMicros, 0);
    return {
      provider: id,
      name: p.name,
      source: p.source,
      plan: best?.plan ?? null,
      monthlyCostMicros: best ? Number(best.cost) : null,
      credits,
      creditsCompared: compared,
      coveredGoogleCostMicros: Number(covered),
      uncovered: uncoveredList,
      uncoveredGoogleCostMicros: uncoveredCost,
      totalMicros: best ? Number(best.cost) + uncoveredCost : null,
      notes: [...notes],
    };
  });

  return {
    periodDays,
    googleCostMicros: Number(googleCost),
    requests: [...bySku.values()].reduce((a, s) => a + s.requests, 0),
    bySku: [...bySku.entries()]
      .map(([sku, s]) => ({
        sku,
        requests: s.requests,
        units: s.units,
        costMicros: Number(s.cost),
      }))
      .sort((a, b) => b.costMicros - a.costMicros),
    alternatives,
    verifiedAt: alts.verifiedAt,
  };
}
