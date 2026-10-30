import type { Catalog } from '../catalog.js';
import { isPriced, priceItems } from '../pricing.js';
import type { Classified, LineItem, PriceCtx, PricedClassified } from '../types.js';

export type Route = { route: string; items: LineItem[] } | { unpriced: string };

export const one = (route: string, sku: string, units = 1n): Route => ({
  route,
  items: [{ sku, units }],
});

/** The JSON object body of a request or response, or null for anything else. */
export function object(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** An integer in [min, max], `fallback` when absent, null when present but out of range. */
export function intIn(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

export function classified(
  provider: string,
  catalog: Catalog,
  r: Route,
  normalizedHash: string,
): Classified {
  if ('unpriced' in r) return { priced: false, provider, reason: r.unpriced, normalizedHash };
  if (!isPriced(catalog.skus, r.items)) {
    return { priced: false, provider, reason: `no verified price for ${r.route}`, normalizedHash };
  }
  return { priced: true, provider, route: r.route, items: r.items, normalizedHash };
}

/** Re-price a request from the units the provider reports, never above the worst case. */
export function capped(
  catalog: Catalog,
  c: PricedClassified,
  items: LineItem[],
  ctx: PriceCtx,
): bigint {
  const worst = priceItems(catalog.skus, c.items, ctx);
  const reported = priceItems(catalog.skus, items, ctx);
  return reported < worst ? reported : worst;
}
