import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  bundledDataFiles,
  catalogOverrideDir,
  loadEveryCatalog,
  priceTable,
  withCatalogDir,
} from '@spend-brake/catalog';
import { type Db, eq, sql } from '@spend-brake/db';
import { parse } from 'yaml';
import { z } from 'zod';
import { CATALOG_FEED_PUBLIC_KEY } from '../license/keys.js';
import { SignatureError, signDocument, verifyDocument } from '@spend-brake/shared';
import { eeCatalogFeed } from '../schema.js';

export const FEED_FORMAT = 'spend-brake-catalog/1';
const KEEP_VERSIONS = 5;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
// A bundle dated further ahead than this is refused: it would block every later one.
const MAX_CLOCK_SKEW_MS = 24 * 3600_000;
const FEED_LOCK = 7_212_026;

const bundleSchema = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  issuedAt: z.iso.datetime(),
  /** Data file path (as under packages/catalog/data) -> its full new content. */
  files: z.record(z.string(), z.string()),
});
export type CatalogBundle = z.infer<typeof bundleSchema>;

export interface PriceChange {
  sku: string;
  /** Human-readable price (tiers joined by /); null when the SKU is absent. */
  from: string | null;
  to: string | null;
}

export function signBundle(bundle: CatalogBundle, privateKeyPem: string): string {
  return signDocument(FEED_FORMAT, bundleSchema.parse(bundle), privateKeyPem);
}

/** Verify the signature and that every file is a known data file with YAML in it. */
export function verifyBundle(text: string, publicKeyPem = CATALOG_FEED_PUBLIC_KEY): CatalogBundle {
  const bundle = bundleSchema.parse(verifyDocument(text, FEED_FORMAT, publicKeyPem));
  const known = new Set(bundledDataFiles());
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!known.has(path))
      throw new SignatureError('malformed', `${path} is not a catalog data file`);
    if (parse(content) === null) throw new SignatureError('malformed', `${path} is empty`);
  }
  return bundle;
}

/** Every price that differs between two catalog directories (null: the bundled data). */
export function priceChanges(from: string | null, to: string | null): PriceChange[] {
  const a = withCatalogDir(from, priceTable);
  const b = withCatalogDir(to, priceTable);
  const changes: PriceChange[] = [];
  for (const sku of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(sku) ?? null;
    const y = b.get(sku) ?? null;
    if (x !== y) changes.push({ sku, from: x, to: y });
  }
  return changes;
}

/** issuedAt (ms) of the version `current` points at, from its directory name. */
async function liveIssuedAt(dir: string): Promise<number | null> {
  try {
    const m = /^(\d+)-/.exec(basename(await readlink(join(dir, 'current'))));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Install a bundle as a new version: copy the version in use, lay the bundle's files over it
 * (bundles may carry only what changed), check that every catalog loads from the result, then
 * point `current` at it with one rename. Readers see the old catalog or the new one, never a mix.
 * Every directory name is new, so a concurrent apply can never remove a live version.
 */
export async function applyBundle(dir: string, bundle: CatalogBundle): Promise<string> {
  const versions = join(dir, 'versions');
  await mkdir(versions, { recursive: true });
  const name = `${Date.parse(bundle.issuedAt)}-${bundle.version}-${randomBytes(4).toString('hex')}`;
  const staging = join(versions, `.staging-${name}`);
  const live = catalogOverrideDirOf(dir);
  try {
    if (live) await cp(live, staging, { recursive: true });
    for (const [file, content] of Object.entries(bundle.files)) {
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await writeFile(join(staging, file), content);
    }
    // The same loaders the proxy, API and worker use: a file that would not load is refused here.
    withCatalogDir(staging, loadEveryCatalog);
    await rename(staging, join(versions, name));
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  const next = join(dir, `.current-${randomBytes(6).toString('hex')}`);
  await symlink(join('versions', name), next);
  await rename(next, join(dir, 'current'));
  await prune(versions, name);
  return join(versions, name);
}

const catalogOverrideDirOf = (dir: string) => catalogOverrideDir({ BRAKE_CATALOG_DIR: dir });

async function prune(versions: string, keep: string): Promise<void> {
  const names = (await readdir(versions)).filter((n) => !n.startsWith('.')).sort();
  for (const old of names.slice(0, -KEEP_VERSIONS)) {
    if (old !== keep) await rm(join(versions, old), { recursive: true, force: true });
  }
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

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BUNDLE_BYTES) throw new Error('catalog feed: bundle too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch, verify and (when newer than the one in use) apply the signed catalog bundle. One
 * worker at a time: the others skip the round.
 */
export async function syncCatalogFeed(db: Db, opts: FeedOptions, now: Date): Promise<FeedResult> {
  const res = await (opts.fetch ?? fetch)(opts.url, {
    headers: { accept: 'application/json', 'user-agent': 'spend-brake-catalog-feed' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`catalog feed: HTTP ${res.status}`);
  const bundle = verifyBundle(await readCapped(res), opts.publicKey);
  const issuedAt = Date.parse(bundle.issuedAt);
  if (issuedAt > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new Error(`catalog feed: bundle ${bundle.version} is dated in the future`);
  }
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(${FEED_LOCK}) as ok`,
    );
    if (!lock.rows[0]?.ok) return { applied: false, version: null, changes: [] };
    const [current] = await tx.select().from(eeCatalogFeed).where(eq(eeCatalogFeed.id, 'feed'));
    // Never go back: a replayed older (validly signed) bundle is ignored, also when the database
    // lost its record (the live directory's name carries its date).
    const newest = Math.max(current?.issuedAt.getTime() ?? 0, (await liveIssuedAt(opts.dir)) ?? 0);
    if (issuedAt <= newest) {
      return { applied: false, version: current?.version ?? null, changes: [] };
    }
    const before = catalogOverrideDirOf(opts.dir);
    const target = await applyBundle(opts.dir, bundle);
    const changes = priceChanges(before, target);
    const row = {
      id: 'feed',
      version: bundle.version,
      issuedAt: new Date(issuedAt),
      appliedAt: now,
    };
    await tx
      .insert(eeCatalogFeed)
      .values(row)
      .onConflictDoUpdate({ target: eeCatalogFeed.id, set: row });
    return { applied: true, version: bundle.version, changes };
  });
}
