import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundledDataFile, readDataFile, loadMapboxCatalog } from '@spend-brake/catalog';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBundle,
  priceChanges,
  signBundle,
  syncCatalogFeed,
  verifyBundle,
} from '../src/feed/feed.js';
import { SignatureError } from '../src/license/signed.js';
import { type Env, startEnv } from './harness.js';

const feedKey = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const MAPBOX = 'mapbox/catalog.yaml';
const original = readBundledDataFile(MAPBOX);
const dearer = original.replace(
  "per1000: ['0.75', '0.60', '0.45', '0.45']",
  "per1000: ['0.90', '0.60', '0.45', '0.45']",
);

const bundle = (
  version: string,
  issuedAt: string,
  files: Record<string, string> = { [MAPBOX]: dearer },
) => signBundle({ version, issuedAt, files }, feedKey.privateKey);

let env: Env;

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

afterEach(() => {
  delete process.env.BRAKE_CATALOG_DIR;
});

describe('signed catalog bundles', () => {
  it('verifies the signature and every file before anything is applied', () => {
    expect(dearer).not.toBe(original);
    expect(verifyBundle(bundle('v1', '2026-10-30T00:00:00Z'), feedKey.publicKey).version).toBe(
      'v1',
    );
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = signBundle(
      { version: 'v1', issuedAt: '2026-10-30T00:00:00Z', files: { [MAPBOX]: dearer } },
      other.privateKey,
    );
    expect(() => verifyBundle(forged, feedKey.publicKey)).toThrow(SignatureError);
    for (const files of [
      { '../etc/passwd.yaml': 'x: 1' },
      { 'mapbox/unknown.yaml': 'x: 1' },
      { [MAPBOX]: 'provider: mapbox\n' },
    ]) {
      expect(() =>
        verifyBundle(bundle('v1', '2026-10-30T00:00:00Z', files), feedKey.publicKey),
      ).toThrow();
    }
  });

  it('lists first-band price changes against the catalog in use', () => {
    const b = verifyBundle(bundle('v1', '2026-10-30T00:00:00Z'), feedKey.publicKey);
    expect(priceChanges(b)).toEqual([
      { file: MAPBOX, sku: 'mapbox.geocoding.temporary', from: '0.75', to: '0.90' },
    ]);
  });

  it('applies atomically, is read by the core loaders, never rolls back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    let served = bundle('v1', '2026-10-30T00:00:00Z');
    const opts = {
      url: 'https://feed.example/catalog.json',
      dir,
      publicKey: feedKey.publicKey,
      fetch: (() => Promise.resolve(new Response(served))) as unknown as typeof fetch,
    };
    const r = await syncCatalogFeed(env.db, opts, env.clock.now);
    expect(r).toMatchObject({ applied: true, version: 'v1', changes: [{ to: '0.90' }] });
    expect(await readlink(join(dir, 'current'))).toMatch(/^versions\/\d+-v1$/);
    process.env.BRAKE_CATALOG_DIR = dir;
    expect(readDataFile(MAPBOX)).toBe(dearer);
    expect(loadMapboxCatalog().skus.get('mapbox.geocoding.temporary')!.per1000![0]).toBe(900_000n);
    // Files the bundle does not carry still come from the package.
    expect(readDataFile('here/catalog.yaml')).toBe(readBundledDataFile('here/catalog.yaml'));

    // A replayed older (validly signed) bundle is ignored.
    served = signBundle(
      { version: 'v0', issuedAt: '2026-10-01T00:00:00Z', files: { [MAPBOX]: original } },
      feedKey.privateKey,
    );
    expect(await syncCatalogFeed(env.db, opts, env.clock.now)).toMatchObject({
      applied: false,
      version: 'v1',
    });
    expect(readDataFile(MAPBOX)).toBe(dearer);

    // A newer one replaces it; old versions are pruned to the last five.
    for (let i = 2; i <= 7; i++) {
      served = bundle(`v${i}`, `2026-10-30T0${i}:00:00Z`);
      expect((await syncCatalogFeed(env.db, opts, env.clock.now)).applied).toBe(true);
    }
    expect(await readlink(join(dir, 'current'))).toMatch(/-v7$/);
    expect((await readdir(join(dir, 'versions'))).length).toBe(5);
  });

  it('rejects a feed answer that does not verify, keeping the catalog in use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
    await applyBundle(dir, verifyBundle(bundle('v1', '2026-10-30T00:00:00Z'), feedKey.publicKey));
    await expect(
      syncCatalogFeed(
        env.db,
        {
          url: 'https://feed.example/x',
          dir,
          publicKey: feedKey.publicKey,
          fetch: () =>
            Promise.resolve(
              new Response('{"format":"spend-brake-catalog/1","payload":"e30","signature":"AA"}'),
            ),
        },
        env.clock.now,
      ),
    ).rejects.toThrow();
    expect(await readlink(join(dir, 'current'))).toMatch(/-v1$/);
  });
});
