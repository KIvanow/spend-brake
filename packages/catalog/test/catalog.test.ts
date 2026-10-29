import { describe, expect, it } from 'vitest';
import { parseCatalog, readDataFile } from '../src/catalog.js';
import { loadGoogleMapsCatalog, loadPlacesFields } from '../src/google-maps/adapter.js';
import { priceUnits } from '../src/pricing.js';
import { ctx } from './helpers.js';

const catalog = loadGoogleMapsCatalog();
const perRequest = (id: string) => priceUnits(catalog.skus.get(id)!, 1n, ctx());

describe('google-maps catalog', () => {
  it('cites its source and verification date', () => {
    expect(catalog.source).toBe('https://developers.google.com/maps/billing-and-pricing/pricing');
    expect(catalog.verifiedAt).toBe('2026-10-29');
    expect(catalog.billingTimeZone).toBe('America/Los_Angeles');
  });

  it('has a verified price for every SKU', () => {
    for (const sku of catalog.skus.values()) {
      expect(sku.free || sku.per1000 !== null, sku.id).toBe(true);
    }
  });

  // First-band list prices from the source page, per single request in micros.
  it.each([
    ['places.autocomplete', 2_830n],
    ['places.details.ids_only', 0n],
    ['places.details.essentials', 5_000n],
    ['places.details.pro', 17_000n],
    ['places.details.enterprise', 20_000n],
    ['places.details.enterprise_atmosphere', 25_000n],
    ['places.photo', 7_000n],
    ['places.text_search.ids_only', 0n],
    ['places.text_search.pro', 32_000n],
    ['places.text_search.enterprise', 35_000n],
    ['places.text_search.enterprise_atmosphere', 40_000n],
    ['places.nearby_search.pro', 32_000n],
    ['places.nearby_search.enterprise', 35_000n],
    ['places.nearby_search.enterprise_atmosphere', 40_000n],
    ['geocoding', 5_000n],
    ['routes.compute_routes.essentials', 5_000n],
    ['routes.compute_routes.pro', 10_000n],
    ['routes.compute_routes.enterprise', 15_000n],
    ['routes.compute_route_matrix.essentials', 5_000n],
    ['routes.compute_route_matrix.pro', 10_000n],
    ['routes.compute_route_matrix.enterprise', 15_000n],
    ['legacy.places.details', 17_000n],
    ['legacy.places.contact_data', 3_000n],
    ['legacy.places.atmosphere_data', 5_000n],
    ['legacy.directions', 5_000n],
    ['legacy.directions_advanced', 10_000n],
    ['legacy.distance_matrix', 5_000n],
    ['legacy.distance_matrix_advanced', 10_000n],
  ])('%s costs %d micros per request', (id, micros) => {
    expect(perRequest(id)).toBe(micros);
  });

  it('applies the top volume band', () => {
    const sku = catalog.skus.get('places.text_search.pro')!;
    expect(priceUnits(sku, 1n, ctx({ 'places.text_search.pro': 5_000_000n }))).toBe(2_400n);
    const legacy = catalog.skus.get('legacy.places.details')!;
    expect(priceUnits(legacy, 1n, ctx({ 'legacy.places.details': 100_000n }))).toBe(13_600n);
  });

  it('rejects malformed catalogs', () => {
    const text = readDataFile('google-maps/catalog.yaml');
    expect(() => parseCatalog(text.replace("'32.00'", "'32,00'"))).toThrow();
    expect(() => parseCatalog(text.replace('band: core', 'band: nope'))).toThrow(/unknown band/);
    expect(() =>
      parseCatalog(text.replace("per1000: ['2.83', '2.27']\n", "per1000: ['2.83']\n")),
    ).toThrow(/prices for/);
    expect(() => parseCatalog(text.replace('verifiedAt: 2026-10-29', ''))).toThrow();
  });

  it('accepts an unverified price as null', () => {
    const text = readDataFile('google-maps/catalog.yaml').replace(
      /(\n {2}geocoding:\n(?: {4}.*\n)*? {4}per1000: )\[.*\]/,
      '$1null\n    todo: verify',
    );
    expect(parseCatalog(text).skus.get('geocoding')!.per1000).toBeNull();
  });
});

describe('places fields data', () => {
  const fields = loadPlacesFields();
  it('cites its source', () => {
    expect(fields.source).toBe(
      'https://developers.google.com/maps/documentation/places/web-service/data-fields',
    );
  });
  it('never bills Text Search at Essentials and Nearby Search below Pro', () => {
    for (const f of Object.values(fields.fields)) {
      expect(f.textSearch).not.toBe('essentials');
      expect(['ids_only', 'essentials']).not.toContain(f.nearbySearch);
    }
  });
});
