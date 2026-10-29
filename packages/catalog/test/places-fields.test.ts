import { describe, expect, it } from 'vitest';
import { GoogleMapsAdapter, loadPlacesFields } from '../src/google-maps/adapter.js';
import { GOLDEN } from './places-fields.golden.js';
import { req } from './helpers.js';

const adapter = new GoogleMapsAdapter();
const fields = loadPlacesFields();

const skuFor = (endpoint: 'details' | 'textSearch' | 'nearbySearch', mask: string) => {
  const r =
    endpoint === 'details'
      ? req('GET', 'https://places.googleapis.com/v1/places/ChIJabc', {
          headers: { 'X-Goog-FieldMask': mask },
        })
      : req(
          'POST',
          `https://places.googleapis.com/v1/places:${endpoint === 'textSearch' ? 'searchText' : 'searchNearby'}`,
          { headers: { 'X-Goog-FieldMask': mask }, body: {} },
        );
  const c = adapter.classify(r);
  if (!c.priced) throw new Error(c.reason);
  return c.items[0]!.sku;
};

describe('places field golden tests', () => {
  it('the data file covers exactly the golden field list', () => {
    expect(Object.keys(fields.fields).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  describe.each(Object.entries(GOLDEN))('%s', (field, [details, text, nearby]) => {
    const top = field === 'nextPageToken' || field === 'routingSummaries';
    it('Place Details', () => {
      expect(skuFor('details', field)).toBe(details ?? 'places.details.enterprise_atmosphere');
    });
    it('Text Search', () => {
      expect(skuFor('textSearch', top ? field : `places.${field}`)).toBe(
        text ?? 'places.text_search.enterprise_atmosphere',
      );
    });
    it('Nearby Search', () => {
      expect(skuFor('nearbySearch', `places.${field}`)).toBe(
        nearby ?? 'places.nearby_search.enterprise_atmosphere',
      );
    });
  });
});

describe('field mask resolution', () => {
  it('bills the highest tier in the mask', () => {
    expect(skuFor('details', 'id,displayName,rating')).toBe('places.details.enterprise');
    expect(skuFor('details', 'id,location')).toBe('places.details.essentials');
    expect(skuFor('textSearch', 'places.id,places.reviews')).toBe(
      'places.text_search.enterprise_atmosphere',
    );
  });

  it('keeps ID-only searches free', () => {
    expect(skuFor('textSearch', 'places.id,places.name,nextPageToken')).toBe(
      'places.text_search.ids_only',
    );
  });

  it('reads sub-field paths by their top-level field', () => {
    expect(skuFor('details', 'displayName.text')).toBe('places.details.pro');
    expect(skuFor('textSearch', 'places.location.latitude')).toBe('places.text_search.pro');
  });

  it('prices wildcards, unknown fields and a missing mask at the highest tier', () => {
    expect(skuFor('details', '*')).toBe('places.details.enterprise_atmosphere');
    expect(skuFor('textSearch', 'places.*')).toBe('places.text_search.enterprise_atmosphere');
    expect(skuFor('textSearch', 'places')).toBe('places.text_search.enterprise_atmosphere');
    expect(skuFor('nearbySearch', 'places.someNewField')).toBe(
      'places.nearby_search.enterprise_atmosphere',
    );
    expect(skuFor('details', '')).toBe('places.details.enterprise_atmosphere');
  });

  it('takes the mask from the fields query parameter too', () => {
    const c = adapter.classify(
      req('GET', 'https://places.googleapis.com/v1/places/ChIJabc?fields=id,rating'),
    );
    expect(c.priced && c.items[0]!.sku).toBe('places.details.enterprise');
  });
});
