import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry, generateVirtualKey, hashVirtualKey, isVirtualKey } from '../src/registry.js';
import { type TestValkey, newOrg, startValkey } from './valkey.js';

let valkey: TestValkey;
let registry: Registry;

beforeAll(async () => {
  valkey = await startValkey();
  registry = new Registry(valkey.client);
});

afterAll(async () => {
  await valkey.stop();
});

describe('virtual keys', () => {
  it('have the documented format and are unique', () => {
    const keys = new Set(Array.from({ length: 1000 }, generateVirtualKey));
    expect(keys.size).toBe(1000);
    for (const k of keys) expect(isVirtualKey(k)).toBe(true);
    expect(isVirtualKey('sb_live_short')).toBe(false);
  });

  it('are stored only by hash and resolve back to their record', async () => {
    const org = newOrg();
    const { token, record } = await registry.createKey({
      id: 'k1',
      orgId: org,
      credentials: { 'google-maps': 'cred1' },
    });
    expect(record).toMatchObject({ status: 'active', skus: null, failOpenMicros: null });
    const stored = await valkey.client.keys('bk:vk:*');
    expect(stored).toContain(`bk:vk:${hashVirtualKey(token)}`);
    const all = await Promise.all(stored.map((k) => valkey.client.get(k)));
    expect(all.join('')).not.toContain(token);
    expect(await registry.getKeyByToken(token)).toEqual(record);
    expect(await registry.getKeyByToken(generateVirtualKey())).toBeNull();
    expect(await registry.getKeyByToken('not-a-key')).toBeNull();

    await registry.revokeKey(token);
    expect((await registry.getKeyByToken(token))?.status).toBe('revoked');
  });

  it('carry an optional name; records without one still parse', async () => {
    const org = newOrg();
    const named = await registry.createKey({
      id: 'k2',
      orgId: org,
      name: 'web app',
      credentials: { 'google-maps': 'cred1' },
    });
    expect((await registry.getKeyByToken(named.token))?.name).toBe('web app');

    // A record written before keys had names (raw JSON, no `name` field).
    const token = generateVirtualKey();
    await valkey.client.set(
      `bk:vk:${hashVirtualKey(token)}`,
      JSON.stringify({ id: 'k3', orgId: org, credentials: { 'google-maps': 'cred1' } }),
    );
    const old = await registry.getKeyByToken(token);
    expect(old).toMatchObject({ id: 'k3', status: 'active' });
    expect(old?.name).toBeUndefined();

    await expect(
      registry.createKey({ id: 'k4', orgId: org, name: 'x'.repeat(201), credentials: {} }),
    ).rejects.toThrow();
  });
});

describe('orgs', () => {
  it('fills defaults', async () => {
    const org = newOrg();
    await registry.putOrg({ id: org });
    expect(await registry.getOrg(org)).toEqual({
      id: org,
      timeZone: 'UTC',
      providers: {},
      loop: { identical: 20, windowSec: 60, perMinute: 300, cooldownSec: 600 },
    });
    expect(await registry.getOrg(newOrg())).toBeNull();
  });
});
