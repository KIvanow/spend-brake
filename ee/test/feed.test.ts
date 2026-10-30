import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMapboxCatalog,
  readBundledDataFile,
  readDataFile,
  withCatalogDir,
} from '@spend-brake/catalog';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBundle,
  priceChanges,
  signBundle,
  syncCatalogFeed,
  verifyBundle,
} from '../src/feed/feed.js';
import { SignatureError } from '@spend-brake/shared';
import { eeCatalogFeed } from '../src/schema.js';
import { type Env, startEnv } from './harness.js';

const feedKey = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const MAPBOX = 'mapbox/catalog.yaml';
const HERE = 'here/catalog.yaml';
const original = readBundledDataFile(MAPBOX);
const dearer = original.replace(
  "per1000: ['0.75', '0.60', '0.45', '0.45']",
  "per1000: ['0.90', '0.60', '0.45', '0.45']",
);
const hereCheaper = readBundledDataFile(HERE).replace(
  "per1000: ['0.88', '0.70', '0.70']",
  "per1000: ['0.80', '0.70', '0.70']",
);

const bundle = (
  version: string,
  issuedAt: string,
  files: Record<string, string> = { [MAPBOX]: dearer },
) => signBundle({ version, issuedAt, files }, feedKey.privateKey);
const verified = (text: string) => verifyBundle(text, feedKey.publicKey);
const mapboxFirstBand = (dir: string | null) =>
  withCatalogDir(
    dir,
    () => loadMapboxCatalog().skus.get('mapbox.geocoding.temporary')!.per1000![0],
  );

let env: Env;
const NOW = new Date('2026-10-30T12:00:00Z');

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

afterEach(async () => {
  delete process.env.BRAKE_CATALOG_DIR;
  await env.db.delete(eeCatalogFeed);
});

const feed = (dir: string, serve: () => string) => ({
  url: 'https://feed.example/catalog.json',
  dir,
  publicKey: feedKey.publicKey,
  fetch: (() => Promise.resolve(new Response(serve()))) as typeof fetch,
});

describe('signed catalog bundles', () => {
  it('verifies the signature and that files are known data files', () => {
    expect(hereCheaper).not.toBe(readBundledDataFile(HERE));
    expect(verified(bundle('v1', '2026-10-30T00:00:00Z')).version).toBe('v1');
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = signBundle(
      { version: 'v1', issuedAt: '2026-10-30T00:00:00Z', files: { [MAPBOX]: dearer } },
      other.privateKey,
    );
    expect(() => verified(forged)).toThrow(SignatureError);
    for (const files of [{ '../etc/passwd.yaml': 'x: 1' }, { 'mapbox/unknown.yaml': 'x: 1' }]) {
      expect(() => verified(bundle('v1', '2026-10-30T00:00:00Z', files))).toThrow();
    }
  });

  it('refuses a validly signed file the services could not load, keeping the version in use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    await applyBundle(dir, verified(bundle('v1', '2026-10-30T00:00:00Z')));
    for (const files of [{ 'twilio/sms.yaml': 'x: 1' }, { [MAPBOX]: 'provider: mapbox\n' }]) {
      await expect(
        applyBundle(dir, verified(bundle('v2', '2026-10-30T01:00:00Z', files))),
      ).rejects.toThrow();
    }
    expect(await readlink(join(dir, 'current'))).toMatch(/-v1-/);
    expect((await readdir(join(dir, 'versions'))).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('carries earlier updates forward when a bundle holds only what changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    await applyBundle(dir, verified(bundle('v1', '2026-10-30T00:00:00Z')));
    const v2 = await applyBundle(
      dir,
      verified(bundle('v2', '2026-10-30T01:00:00Z', { [HERE]: hereCheaper })),
    );
    expect(mapboxFirstBand(v2)).toBe(900_000n);
    expect(withCatalogDir(v2, () => readDataFile(HERE))).toBe(hereCheaper);
  });

  it('lists every price that changed, Twilio included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    const sms = readBundledDataFile('twilio/sms.yaml').replace(
      "DE: { name: 'Germany', sms: '",
      "DE: { name: 'Germany', sms: '9",
    );
    const v = await applyBundle(
      dir,
      verified(bundle('v1', '2026-10-30T00:00:00Z', { [MAPBOX]: dearer, 'twilio/sms.yaml': sms })),
    );
    const changes = priceChanges(null, v);
    expect(changes).toContainEqual({
      sku: 'mapbox.geocoding.temporary',
      from: '0.75/0.6/0.45/0.45 per 1,000',
      to: '0.9/0.6/0.45/0.45 per 1,000',
    });
    expect(changes.some((c) => c.sku === 'twilio.sms.DE')).toBe(true);
  });
});

describe('syncing the feed', () => {
  it('applies atomically, is read by the core loaders, never rolls back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    let served = bundle('v1', '2026-10-30T00:00:00Z');
    const opts = feed(dir, () => served);
    const r = await syncCatalogFeed(env.db, opts, NOW);
    expect(r.applied).toBe(true);
    expect(r.changes).toContainEqual(
      expect.objectContaining({ sku: 'mapbox.geocoding.temporary' }),
    );
    expect(await readlink(join(dir, 'current'))).toMatch(/^versions\/\d+-v1-[0-9a-f]+$/);
    process.env.BRAKE_CATALOG_DIR = dir;
    expect(readDataFile(MAPBOX)).toBe(dearer);
    expect(readDataFile(HERE)).toBe(readBundledDataFile(HERE));

    // A replayed older bundle is ignored, even after the database lost its record.
    served = signBundle(
      { version: 'v0', issuedAt: '2026-10-01T00:00:00Z', files: { [MAPBOX]: original } },
      feedKey.privateKey,
    );
    expect((await syncCatalogFeed(env.db, opts, NOW)).applied).toBe(false);
    await env.db.delete(eeCatalogFeed);
    expect((await syncCatalogFeed(env.db, opts, NOW)).applied).toBe(false);
    expect(readDataFile(MAPBOX)).toBe(dearer);

    // Dated far in the future: refused (it would block every later bundle).
    served = bundle('v9', '2027-10-30T00:00:00Z');
    await expect(syncCatalogFeed(env.db, opts, NOW)).rejects.toThrow(/future/);

    // Newer ones replace it; old versions are pruned to the last five.
    for (let i = 2; i <= 7; i++) {
      served = bundle(`v${i}`, `2026-10-30T0${i}:00:00Z`);
      expect((await syncCatalogFeed(env.db, opts, NOW)).applied).toBe(true);
    }
    expect(await readlink(join(dir, 'current'))).toMatch(/-v7-/);
    expect((await readdir(join(dir, 'versions'))).length).toBe(5);
  });

  it('lets one worker apply at a time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    const opts = feed(dir, () => bundle('v1', '2026-10-30T00:00:00Z'));
    const results = await Promise.all([1, 2, 3].map(() => syncCatalogFeed(env.db, opts, NOW)));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(mapboxFirstBand(join(dir, await readlink(join(dir, 'current'))))).toBe(900_000n);
  });

  it('rejects a feed answer that does not verify, keeping the catalog in use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    await applyBundle(dir, verified(bundle('v1', '2026-10-30T00:00:00Z')));
    const bad = feed(
      dir,
      () => '{"format":"spend-brake-catalog/1","payload":"e30","signature":"AA"}',
    );
    await expect(syncCatalogFeed(env.db, bad, NOW)).rejects.toThrow();
    expect(await readlink(join(dir, 'current'))).toMatch(/-v1-/);
  });
});
