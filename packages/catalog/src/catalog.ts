import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { type SkuPrice, parseUsd } from './pricing.js';

const usd = z.string().regex(/^\d+(\.\d{1,6})?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const skuSchema = z.union([
  z.strictObject({ googleSku: z.string().optional(), name: z.string(), free: z.literal(true) }),
  z.strictObject({
    /** Google's SKU id (billing export); other providers have none. */
    googleSku: z.string().optional(),
    name: z.string(),
    band: z.string(),
    freeMonthly: z.number().int().nonnegative(),
    /** null = not verified yet; such SKUs are unpriced and denied by default. */
    per1000: z.array(usd).nullable(),
    todo: z.string().optional(),
  }),
]);

const catalogSchema = z.strictObject({
  provider: z.string(),
  version: isoDate,
  source: z.url(),
  skuSource: z.url().optional(),
  sourceUpdated: isoDate,
  verifiedAt: isoDate,
  currency: z.literal('USD'),
  billingTimeZone: z.string(),
  bands: z.record(z.string(), z.array(z.number().int().positive().nullable())),
  skus: z.record(z.string(), skuSchema),
});

export interface Catalog {
  provider: string;
  version: string;
  source: string;
  verifiedAt: string;
  billingTimeZone: string;
  skus: ReadonlyMap<string, SkuPrice>;
}

export function parseCatalog(yamlText: string): Catalog {
  const raw = catalogSchema.parse(parse(yamlText));
  const skus = new Map<string, SkuPrice>();
  for (const [id, s] of Object.entries(raw.skus)) {
    if ('free' in s) {
      skus.set(id, {
        id,
        name: s.name,
        ...(s.googleSku ? { googleSku: s.googleSku } : {}),
        free: true,
        freeMonthly: 0n,
        bands: [],
        per1000: [],
      });
      continue;
    }
    const bands = raw.bands[s.band];
    if (!bands) throw new Error(`sku ${id}: unknown band ${s.band}`);
    if (bands.at(-1) !== null) throw new Error(`band ${s.band} must end open-ended`);
    if (s.per1000 && s.per1000.length !== bands.length) {
      throw new Error(`sku ${id}: ${s.per1000.length} prices for ${bands.length} bands`);
    }
    skus.set(id, {
      id,
      name: s.name,
      ...(s.googleSku ? { googleSku: s.googleSku } : {}),
      free: false,
      freeMonthly: BigInt(s.freeMonthly),
      bands: bands.map((b) => (b === null ? null : BigInt(b))),
      per1000: s.per1000 ? s.per1000.map(parseUsd) : null,
    });
  }
  return {
    provider: raw.provider,
    version: raw.version,
    source: raw.source,
    verifiedAt: raw.verifiedAt,
    billingTimeZone: raw.billingTimeZone,
    skus,
  };
}

/**
 * Where updated catalog data lives, if anywhere: `$BRAKE_CATALOG_DIR/current` (a symlink to one
 * complete version, swapped atomically). Files missing there come from the bundled data.
 */
export function catalogOverrideDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.BRAKE_CATALOG_DIR;
  if (!dir) return null;
  const current = join(dir, 'current');
  return existsSync(current) ? realpathSync(current) : null;
}

/** The catalog data shipped with this package; works from both src/ and dist/. */
export function readBundledDataFile(relative: string): string {
  return readFileSync(new URL(`../data/${relative}`, import.meta.url), 'utf8');
}

/** A data file: the updated copy when one is installed, otherwise the bundled one. */
export function readDataFile(relative: string): string {
  const dir = catalogOverrideDir();
  if (dir) {
    const path = join(dir, relative);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return readBundledDataFile(relative);
}
