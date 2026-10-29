import { describe, expect, it } from 'vitest';
import {
  type UsageRow,
  endpointOf,
  estimateMigration,
  loadAlternatives,
} from '../src/migration.js';

const alts = loadAlternatives();
const row = (
  sku: string,
  day: string,
  requests: number,
  units = requests,
  cost = 0n,
): UsageRow => ({
  sku,
  day,
  requests,
  units,
  costMicros: cost,
});
const alt = (r: ReturnType<typeof estimateMigration>, id: string) =>
  r.alternatives.find((a) => a.provider === id)!;

describe('alternatives data', () => {
  it('cites a source for every provider and lists plans cheapest first', () => {
    for (const p of Object.values(alts.providers)) {
      expect(p.source).toMatch(/^https:\/\//);
      const prices = p.plans.map((x) => Number(x.usdPerMonth));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    }
    expect(alts.verifiedAt).toBe('2026-10-29');
  });
});

describe('estimateMigration', () => {
  it('strips the tier from SKUs', () => {
    expect(endpointOf('places.text_search.enterprise_atmosphere')).toBe('places.text_search');
    expect(endpointOf('geocoding')).toBe('geocoding');
  });

  it('picks the cheapest Geoapify plan for the busiest day', () => {
    // 2,000 geocodes a day, 4,000 on one day: Free (3,000/day) is not enough.
    const rows = [
      row('geocoding', '2026-10-01', 2000, 2000, 10_000_000n),
      row('geocoding', '2026-10-02', 4000, 4000, 20_000_000n),
    ];
    const r = estimateMigration(rows, alts);
    expect(r.googleCostMicros).toBe(30_000_000);
    expect(alt(r, 'geoapify')).toMatchObject({
      plan: 'API 10',
      monthlyCostMicros: 59_000_000,
      creditsCompared: 4000,
      credits: 6000,
    });
  });

  it('prices Stadia with overage and skips the non-commercial free plan', () => {
    // 60,000 geocodes x 20 credits = 1.2M credits: Starter $20 + 200k x $0.03/1000 = $26.
    const r = estimateMigration(
      [row('geocoding', '2026-10-01', 60_000, 60_000, 300_000_000n)],
      alts,
    );
    expect(alt(r, 'stadia')).toMatchObject({
      plan: 'Starter',
      monthlyCostMicros: 26_000_000,
      credits: 1_200_000,
    });
  });

  it('keeps unsupported SKUs on Google and counts their cost', () => {
    const rows = [
      row('places.text_search.pro', '2026-10-01', 50_000, 50_000, 1_600_000_000n),
      row('geocoding', '2026-10-01', 1000, 1000, 5_000_000n),
      row('places.photo', '2026-10-01', 100, 100, 700_000n),
    ];
    const r = estimateMigration(rows, alts);
    const op = alt(r, 'openplacesapi');
    expect(op).toMatchObject({
      plan: 'Startup',
      monthlyCostMicros: 49_000_000,
      coveredGoogleCostMicros: 1_600_000_000,
    });
    expect(op.uncovered.map((u) => u.sku)).toEqual(['geocoding', 'places.photo']);
    expect(op.uncoveredGoogleCostMicros).toBe(5_700_000);
    expect(op.totalMicros).toBe(54_700_000);
    expect(alt(r, 'geoapify').uncovered.map((u) => u.sku)).toEqual(['places.photo']);
  });

  it('flags usage beyond every listed plan', () => {
    const r = estimateMigration([row('places.text_search.pro', '2026-10-01', 2_000_000)], alts);
    expect(alt(r, 'openplacesapi')).toMatchObject({
      plan: null,
      monthlyCostMicros: null,
      totalMicros: null,
    });
    expect(alt(r, 'openplacesapi').notes.join()).toContain('Scale');
  });

  it('costs nothing on free plans for small usage', () => {
    const r = estimateMigration([row('geocoding', '2026-10-01', 100)], alts);
    expect(alt(r, 'geoapify')).toMatchObject({ plan: 'Free', monthlyCostMicros: 0 });
    // Stadia's free plan would fit, but it does not allow commercial use.
    expect(alt(r, 'stadia')).toMatchObject({ plan: 'Starter', monthlyCostMicros: 20_000_000 });
    expect(alt(r, 'stadia').notes).toContain('Free plan: commercial use not allowed');
  });
});
