import { describe, expect, it } from 'vitest';
import { keys, killLabel, scopeLabel } from '../src/keys.js';

describe('keys', () => {
  it('puts every key for an org under the same hash tag', () => {
    const k = keys('acme');
    const all = [
      k.spent('org', 'd:20261029'),
      k.held('key:k1', 'm:202610'),
      k.cap('sku:google-maps:places.text_search.pro', 'd'),
      k.alerted('env:ci', 'd:20261029'),
      k.res('r1'),
      k.resexp(),
      k.kill(),
    ];
    for (const key of all) expect(key.startsWith('bk:{o:acme}:')).toBe(true);
  });

  it('labels scopes and kill targets', () => {
    expect(scopeLabel({ kind: 'org' })).toBe('org');
    expect(scopeLabel({ kind: 'sku', provider: 'google-maps', sku: 'geocoding' })).toBe(
      'sku:google-maps:geocoding',
    );
    expect(scopeLabel({ kind: 'sess', id: 's1' })).toBe('sess:s1');
    expect(scopeLabel({ kind: 'agent', id: 'a1' })).toBe('agent:a1');
    expect(killLabel({ kind: 'prov', name: 'google-maps' })).toBe('prov:google-maps');
    expect(killLabel({ kind: 'sess', id: 's1' })).toBe('sess:s1');
  });

  it('rejects ids that could break the hash tag or key layout', () => {
    expect(() => keys('a}b')).toThrow();
    expect(() => keys('')).toThrow();
    expect(() => scopeLabel({ kind: 'key', id: 'a b' })).toThrow();
    expect(() => scopeLabel({ kind: 'env', name: 'x{y' })).toThrow();
    expect(() => killLabel({ kind: 'key', id: '' })).toThrow();
  });
});
