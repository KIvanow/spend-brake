import type { LineItem, PriceCtx } from './types.js';

export const MICROS_PER_USD = 1_000_000n;

export interface SkuPrice {
  id: string;
  name: string;
  /** Google's own SKU id (as in the billing export), when the provider is Google. */
  googleSku?: string;
  /** No charge at any volume. */
  free: boolean;
  freeMonthly: bigint;
  /** Upper bound (inclusive) of each monthly volume band; null is open-ended. */
  bands: (bigint | null)[];
  /** Micros per 1,000 events for each band; null when the price is not verified yet. */
  per1000: bigint[] | null;
}

/** Parse a decimal USD string such as `2.83` into integer micros, exactly. */
export function parseUsd(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!m) throw new Error(`invalid USD amount: ${JSON.stringify(value)}`);
  return BigInt(m[1]!) * MICROS_PER_USD + BigInt((m[2] ?? '').padEnd(6, '0'));
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Cost in micros of `units` more events of one SKU, given how many the proxy already counted this
 * month. Units that straddle a band boundary are split across bands. Rounds up, so a cap is never
 * undercharged by rounding.
 */
export function priceUnits(sku: SkuPrice, units: bigint, ctx: PriceCtx): bigint {
  if (units <= 0n || sku.free) return 0n;
  if (!sku.per1000) throw new Error(`sku ${sku.id} has no verified price`);
  const before = ctx.monthlyUnits.get(sku.id) ?? 0n;
  let from = before; // events already used; the next event is number from + 1
  const to = before + units;

  if (ctx.trustFreeTier && from < sku.freeMonthly)
    from = sku.freeMonthly < to ? sku.freeMonthly : to;

  let numerator = 0n; // sum of units * micros-per-1000
  for (let i = 0; i < sku.bands.length && from < to; i++) {
    const upper = sku.bands[i]!;
    if (upper !== null && upper <= from) continue;
    const end = upper === null || upper > to ? to : upper;
    numerator += (end - from) * sku.per1000[i]!;
    from = end;
  }
  return ceilDiv(numerator, 1000n);
}

export function priceItems(
  skus: ReadonlyMap<string, SkuPrice>,
  items: readonly LineItem[],
  ctx: PriceCtx,
): bigint {
  let total = 0n;
  for (const item of items) {
    const sku = skus.get(item.sku);
    if (!sku) throw new Error(`unknown sku ${item.sku}`);
    total += priceUnits(sku, item.units, ctx);
  }
  return total;
}

export function isPriced(skus: ReadonlyMap<string, SkuPrice>, items: readonly LineItem[]): boolean {
  return items.every((i) => {
    const sku = skus.get(i.sku);
    return sku !== undefined && (sku.free || sku.per1000 !== null);
  });
}
