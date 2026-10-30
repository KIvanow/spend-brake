import { mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseCatalog, readBundledDataFile, readDataFile } from '@spend-brake/catalog';
import { type Db, eq } from '@spend-brake/db';
import { parse } from 'yaml';
import { z } from 'zod';
import { CATALOG_FEED_PUBLIC_KEY } from '../license/keys.js';
import { SignatureError, signDocument, verifyDocument } from '../license/signed.js';
import { eeCatalogFeed } from '../schema.js';

export const FEED_FORMAT = 'spend-brake-catalog/1';
const KEEP_VERSIONS = 5;
const FILE = /^[a-z0-9-]+\/[a-z0-9_.-]+\.yaml$/;

const bundleSchema = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  issuedAt: z.iso.datetime(),
  /** Data file path (as under packages/catalog/data) -> its full new content. */
  files: z.record(z.string(), z.string()),
});
export type CatalogBundle = z.infer<typeof bundleSchema>;

export interface PriceChange {
  file: string;
  sku: string;
  /** First-band USD per 1,000; null when unpriced or absent. */
  from: string | null;
  to: string | null;
}

export function signBundle(bundle: CatalogBundle, privateKeyPem: string): string {
  return signDocument(FEED_FORMAT, bundleSchema.parse(bundle), privateKeyPem);
}

/** Verify the signature, then that every file is one the catalog knows and parses. */
export function verifyBundle(text: string, publicKeyPem = CATALOG_FEED_PUBLIC_KEY): CatalogBundle {
  const bundle = bundleSchema.parse(verifyDocument(text, FEED_FORMAT, publicKeyPem));
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!FILE.test(path)) throw new SignatureError('malformed', `bad file path ${path}`);
    try {
      readBundledDataFile(path);
    } catch {
      throw new SignatureError('malformed', `${path} is not a catalog data file`);
    }
    if (path.endsWith('/catalog.yaml')) parseCatalog(content);
    else if (parse(content) === null) throw new SignatureError('malformed', `${path} is empty`);
  }
  return bundle;
}

type Skus = Record<string, { per1000?: string[] | null } | undefined>;
const skusOf = (text: string | null): Skus =>
  text ? ((parse(text) as { skus?: Skus } | null)?.skus ?? {}) : {};

/** First-band price changes between the catalogs in use and a bundle. */
export function priceChanges(bundle: CatalogBundle, current = readDataFile): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const [file, content] of Object.entries(bundle.files)) {
    if (!file.endsWith('/catalog.yaml')) continue;
    let before: string | null;
    try {
      before = current(file);
    } catch {
      before = null;
    }
    const a = skusOf(before);
    const b = skusOf(content);
    for (const sku of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[sku]?.per1000 ?? null) === JSON.stringify(b[sku]?.per1000 ?? null)) {
        continue;
      }
      changes.push({
        file,
        sku,
        from: a[sku]?.per1000?.[0] ?? null,
        to: b[sku]?.per1000?.[0] ?? null,
      });
    }
  }
  return changes;
}

/**
 * Write the bundle as a new version directory, then point `current` at it with one rename, so
 * readers see either the old catalog or the new one, never a mix. Old versions are pruned.
 */
export async function applyBundle(dir: string, bundle: CatalogBundle): Promise<string> {
  const name = `${Date.parse(bundle.issuedAt)}-${bundle.version}`;
  const target = join(dir, 'versions', name);
  await rm(target, { recursive: true, force: true });
  for (const [file, content] of Object.entries(bundle.files)) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), content, { flag: 'wx' });
  }
  const next = join(dir, `current.next-${process.pid}`);
  await rm(next, { force: true });
  await symlink(join('versions', name), next);
  await rename(next, join(dir, 'current'));
  const versions = (await readdir(join(dir, 'versions'))).sort();
  for (const old of versions.slice(0, -KEEP_VERSIONS)) {
    if (old !== name) await rm(join(dir, 'versions', old), { recursive: true, force: true });
  }
  return target;
}

export interface FeedOptions {
  url: string;
  /** BRAKE_CATALOG_DIR, shared with the proxy, API and worker. */
  dir: string;
  publicKey?: string;
  fetch?: typeof fetch;
}

export interface FeedResult {
  applied: boolean;
  version: string | null;
  changes: PriceChange[];
}

/** Fetch, verify and (when newer than the one in use) apply the signed catalog bundle. */
export async function syncCatalogFeed(db: Db, opts: FeedOptions, now: Date): Promise<FeedResult> {
  const res = await (opts.fetch ?? fetch)(opts.url, {
    headers: { accept: 'application/json', 'user-agent': 'spend-brake-catalog-feed' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`catalog feed: HTTP ${res.status}`);
  const bundle = verifyBundle(await res.text(), opts.publicKey);
  const [current] = await db.select().from(eeCatalogFeed).where(eq(eeCatalogFeed.id, 'feed'));
  // Never go back: a replayed older bundle (still validly signed) is ignored.
  if (current && Date.parse(bundle.issuedAt) <= current.issuedAt.getTime()) {
    return { applied: false, version: current.version, changes: [] };
  }
  const changes = priceChanges(bundle);
  await applyBundle(opts.dir, bundle);
  const row = {
    id: 'feed',
    version: bundle.version,
    issuedAt: new Date(bundle.issuedAt),
    appliedAt: now,
  };
  await db
    .insert(eeCatalogFeed)
    .values(row)
    .onConflictDoUpdate({ target: eeCatalogFeed.id, set: row });
  return { applied: true, version: bundle.version, changes };
}
