import { createHash } from 'node:crypto';

function canonical(value: unknown, drop: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, drop));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => !drop.has(k))
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k], drop)]),
    );
  }
  return value;
}

export interface HashInput {
  method: string;
  origin: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
  fieldMask?: string | undefined;
  /** Query params and body keys that change between otherwise identical requests. */
  volatile?: readonly string[];
}

/** Hash of a request with credentials and volatile fields removed, for loop detection. */
export function normalizedHash(input: HashInput): string {
  const drop = new Set(input.volatile ?? []);
  const query = [...input.query.entries()]
    .filter(([k]) => !drop.has(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const mask = input.fieldMask
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .sort()
    .join(',');
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.method.toUpperCase(),
        input.origin,
        input.path,
        query,
        canonical(input.body ?? null, drop),
        mask ?? null,
      ]),
    )
    .digest('hex');
}
