import { describe, expect, it } from 'vitest';
import {
  countLocations,
  directionsSku,
  distanceMatrixItem,
  encodedPolylinePoints,
  legacyDataSkus,
} from '../src/google-maps/legacy.js';

const skus = (fields: string | null) => legacyDataSkus(fields).map((i) => i.sku);

describe('legacy Places data SKUs', () => {
  it('charges nothing extra for Basic fields', () => {
    expect(skus('place_id,name,geometry/location,formatted_address')).toEqual([]);
  });
  it('adds Contact and Atmosphere by field', () => {
    expect(skus('name,website')).toEqual(['legacy.places.contact_data']);
    expect(skus('rating,reviews')).toEqual(['legacy.places.atmosphere_data']);
    expect(skus('opening_hours,price_level')).toEqual([
      'legacy.places.contact_data',
      'legacy.places.atmosphere_data',
    ]);
  });
  it('treats no field list or unknown fields as everything', () => {
    expect(skus(null)).toHaveLength(2);
    expect(skus('name,mystery_field')).toHaveLength(2);
  });
});

describe('polylines', () => {
  it('counts points in an encoded polyline', () => {
    // Google's documented example: 3 points.
    expect(encodedPolylinePoints('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toBe(3);
    expect(countLocations('enc:_p~iF~ps|U_ulLnnqC_mqNvxq`@:|Paris|Berlin')).toBe(5);
    expect(countLocations(null)).toBe(0);
  });
});

describe('Directions (Legacy)', () => {
  const sku = (qs: string) => directionsSku(new URLSearchParams(qs));
  it('is basic by default', () => {
    expect(sku('origin=A&destination=B&waypoints=C|D')).toBe('legacy.directions');
  });
  it.each([
    'origin=A&destination=B&departure_time=now',
    'origin=A&destination=B&waypoints=optimize:true|C|D',
    `origin=A&destination=B&waypoints=${Array.from({ length: 11 }, (_, i) => `W${i}`).join('|')}`,
    'origin=side_of_road:1,2&destination=B',
    'origin=A&destination=heading=90:1,2',
  ])('is Advanced for %s', (qs) => {
    expect(sku(qs)).toBe('legacy.directions_advanced');
  });
});

describe('Distance Matrix (Legacy)', () => {
  it('bills origins x destinations elements', () => {
    expect(distanceMatrixItem(new URLSearchParams('origins=A|B&destinations=C|D|E'))).toEqual({
      sku: 'legacy.distance_matrix',
      units: 6n,
    });
  });
  it('is Advanced with traffic', () => {
    expect(
      distanceMatrixItem(new URLSearchParams('origins=A&destinations=B&departure_time=now')).sku,
    ).toBe('legacy.distance_matrix_advanced');
  });
});
