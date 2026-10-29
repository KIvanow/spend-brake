import type { IncomingReq, PriceCtx } from '../src/types.js';

export const ctx = (monthly: Record<string, bigint> = {}, trustFreeTier = false): PriceCtx => ({
  monthlyUnits: new Map(Object.entries(monthly)),
  trustFreeTier,
});

export function req(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): IncomingReq {
  const u = new URL(url);
  return {
    method,
    origin: u.origin,
    path: u.pathname,
    query: u.searchParams,
    headers: Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    body: opts.body,
  };
}
