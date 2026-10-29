import { describe, expect, it } from 'vitest';
import {
  type UsageRow,
  endpointOf,
  estimateMigration,
  loadAlternatives,
  loadPayAsYouGo,
} from '../src/migration.js';
import { loadHereCatalog } from '../src/here/adapter.js';
import { loadMapboxCatalog } from '../src/mapbox/adapter.js';

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

  it('compares a month of usage with monthly plans whatever the period', () => {
    // 90 days with 270,000 searches is 90,000 a month: Startup (100k), not Business.
    const r = estimateMigration(
      [row('places.text_search.pro', '2026-08-01', 270_000, 270_000, 900n)],
      alts,
      90,
    );
    expect(alt(r, 'openplacesapi')).toMatchObject({ plan: 'Startup', creditsCompared: 90_000 });
    expect(r.monthlyGoogleCostMicros).toBe(300);
  });

  it('costs nothing on free plans for small usage', () => {
    const r = estimateMigration([row('geocoding', '2026-10-01', 100)], alts);
    expect(alt(r, 'geoapify')).toMatchObject({ plan: 'Free', monthlyCostMicros: 0 });
    // Stadia's free plan would fit, but it does not allow commercial use.
    expect(alt(r, 'stadia')).toMatchObject({ plan: 'Starter', monthlyCostMicros: 20_000_000 });
    expect(alt(r, 'stadia').notes).toContain('Free plan: commercial use not allowed');
  });
});

describe('pay-as-you-go estimates (Mapbox, HERE)', () => {
  const payg = {
    providers: loadPayAsYouGo(),
    catalogs: new Map([
      ['mapbox', loadMapboxCatalog()],
      ['here', loadHereCatalog()],
    ]),
  };

  it('prices the same ledger through each catalog side by side with Google', () => {
    const rows = [
      row('geocoding', '2026-10-01', 200_000, 200_000, 1_000_000_000n),
      // One session of five keystrokes: Google bills the first request (1 unit).
      row('legacy.places.autocomplete_session', '2026-10-01', 5, 1, 17_000n),
      row('places.details.pro', '2026-10-01', 10, 10, 170_000n),
    ];
    const r = estimateMigration(rows, alts, 30, payg);
    expect(alt(r, 'mapbox')).toMatchObject({
      plan: 'Pay as you go',
      // 200,000 x $0.75/1000 + one session at $11.50/1000.
      monthlyCostMicros: 150_011_500,
      uncoveredGoogleCostMicros: 170_000,
      totalMicros: 150_181_500,
      source: 'https://www.mapbox.com/pricing',
    });
    expect(alt(r, 'mapbox').notes).toContain('free allowances not applied');
    // HERE: 200,000 x $0.88/1000 + five autosuggest requests at $2.92/1000.
    expect(alt(r, 'here')).toMatchObject({ monthlyCostMicros: 176_014_600 });
    expect(alt(r, 'here').uncovered.map((u) => u.sku)).toEqual(['places.details.pro']);
    expect(alt(r, 'geoapify')).toBeDefined();
  });

  it('applies free allowances when asked and maps route tiers', () => {
    const rows = [
      row('geocoding', '2026-10-01', 200_000),
      row('routes.compute_routes.essentials', '2026-10-01', 1000),
      row('routes.compute_routes.pro', '2026-10-01', 1000),
    ];
    const free = estimateMigration(rows, alts, 30, { ...payg, includeFreeTier: true });
    // Mapbox: 100,000 free geocodes, directions inside the 100,000 free.
    expect(alt(free, 'mapbox').monthlyCostMicros).toBe(75_000_000);
    const paid = estimateMigration(rows, alts, 30, payg);
    // HERE: 200,000 x 0.88 + 1,000 basic routes x 0.88 + 1,000 time-aware x 2.92.
    expect(alt(paid, 'here').monthlyCostMicros).toBe(176_000_000 + 880_000 + 2_920_000);
  });
});
