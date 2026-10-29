import { describe, expect, it } from 'vitest';
import { type SkuPrice, parseUsd, priceUnits } from '../src/pricing.js';
import { ctx } from './helpers.js';

const sku: SkuPrice = {
  id: 'x',
  name: 'X',
  free: false,
  freeMonthly: 5000n,
  bands: [100_000n, 500_000n, null],
  per1000: [parseUsd('32.00'), parseUsd('25.60'), parseUsd('19.20')],
};

describe('parseUsd', () => {
  it('parses decimal dollars into exact micros', () => {
    expect(parseUsd('32.00')).toBe(32_000_000n);
    expect(parseUsd('2.83')).toBe(2_830_000n);
    expect(parseUsd('0.045')).toBe(45_000n);
    expect(parseUsd('7')).toBe(7_000_000n);
    expect(parseUsd('0.000001')).toBe(1n);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '-1', '1.2345678', '1e3', '$5', ' 1']) {
      expect(() => parseUsd(bad)).toThrow();
    }
  });
});

describe('priceUnits', () => {
  it('prices one request at the first band, ignoring the free cap by default', () => {
    expect(priceUnits(sku, 1n, ctx())).toBe(32_000n);
  });

  it('uses the band for the monthly volume so far', () => {
    expect(priceUnits(sku, 1n, ctx({ x: 100_000n }))).toBe(25_600n);
    expect(priceUnits(sku, 1n, ctx({ x: 499_999n }))).toBe(25_600n);
    expect(priceUnits(sku, 1n, ctx({ x: 500_000n }))).toBe(19_200n);
    expect(priceUnits(sku, 1n, ctx({ x: 9_000_000n }))).toBe(19_200n);
  });

  it('splits units that straddle a band boundary', () => {
    // 2 units at $32/1000 and 3 at $25.60/1000
    expect(priceUnits(sku, 5n, ctx({ x: 99_998n }))).toBe(2n * 32_000n + 3n * 25_600n);
  });

  it('prices the free allowance at zero only with trustFreeTier', () => {
    expect(priceUnits(sku, 1n, ctx({ x: 0n }, true))).toBe(0n);
    expect(priceUnits(sku, 1n, ctx({ x: 4_999n }, true))).toBe(0n);
    expect(priceUnits(sku, 1n, ctx({ x: 5_000n }, true))).toBe(32_000n);
    expect(priceUnits(sku, 3n, ctx({ x: 4_999n }, true))).toBe(2n * 32_000n);
  });

  it('rounds partial micros up', () => {
    const tiny: SkuPrice = { ...sku, bands: [null], per1000: [parseUsd('0.0015')] };
    expect(priceUnits(tiny, 1n, ctx())).toBe(2n); // 1.5 micros
    expect(priceUnits(tiny, 2n, ctx())).toBe(3n);
  });

  it('charges nothing for free SKUs or zero units', () => {
    expect(priceUnits({ ...sku, free: true }, 10n, ctx())).toBe(0n);
    expect(priceUnits(sku, 0n, ctx())).toBe(0n);
  });

  it('refuses to price an unverified SKU', () => {
    expect(() => priceUnits({ ...sku, per1000: null }, 1n, ctx())).toThrow(/no verified price/);
  });
});
