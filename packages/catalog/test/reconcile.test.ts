import { describe, expect, it } from 'vitest';
import { loadGoogleMapsCatalog } from '../src/google-maps/adapter.js';
import { googleSkuIndex, skuFamily } from '../src/reconcile.js';

describe('reconciliation mapping', () => {
  it('groups SKUs into families billed the same way on both sides', () => {
    expect(skuFamily('places.text_search.enterprise_atmosphere')).toBe('places.text_search');
    expect(skuFamily('legacy.places.details')).toBe('legacy.places');
    expect(skuFamily('legacy.places.contact_data')).toBe('legacy.places');
    expect(skuFamily('legacy.directions_advanced')).toBe('legacy.directions');
    expect(skuFamily('legacy.distance_matrix_advanced')).toBe('legacy.distance_matrix');
    expect(skuFamily('geocoding')).toBe('geocoding');
  });

  it('maps every Google SKU id in the catalog to one catalog SKU', () => {
    const catalog = loadGoogleMapsCatalog();
    const index = googleSkuIndex(catalog);
    expect(index.size).toBe(catalog.skus.size);
    expect(index.get('4FDA-34B1-A910')).toBe('places.text_search.pro');
    expect(index.get('BAC8-4E68-E261')).toBe('geocoding');
  });
});
