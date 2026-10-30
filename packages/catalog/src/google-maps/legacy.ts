// Legacy web services on maps.googleapis.com: Places (Legacy), Directions, Distance Matrix.
// Source: https://developers.google.com/maps/billing-and-pricing/sku-details
import type { LineItem } from '../types.js';

// Legacy Places data SKUs, web-service field names as listed on the SKU page.
const BASIC = new Set([
  'address_component',
  'adr_address',
  'business_status',
  'formatted_address',
  'geometry',
  'icon',
  'name',
  'permanently_closed',
  'photo',
  'place_id',
  'plus_code',
  'type',
  'url',
  'utc_offset',
  'vicinity',
  'wheelchair_accessible_entrance',
]);
const CONTACT = new Set([
  'formatted_phone_number',
  'international_phone_number',
  'opening_hours',
  'current_opening_hours',
  'secondary_opening_hours',
  'website',
]);
const ATMOSPHERE = new Set([
  'curbside_pickup',
  'delivery',
  'dine_in',
  'editorial_summary',
  'price_level',
  'rating',
  'reservable',
  'reviews',
  'serves_beer',
  'serves_breakfast',
  'serves_brunch',
  'serves_dinner',
  'serves_lunch',
  'serves_vegetarian_food',
  'serves_wine',
  'takeout',
  'user_ratings_total',
]);

const one = (sku: string): LineItem => ({ sku, units: 1n });

/**
 * Data SKUs triggered by a legacy `fields` list. No list means every field, and an unknown field
 * counts as both Contact and Atmosphere, so we never undercharge.
 */
export function legacyDataSkus(fields: string | null): LineItem[] {
  if (fields === null) {
    return [one('legacy.places.contact_data'), one('legacy.places.atmosphere_data')];
  }
  let contact = false;
  let atmosphere = false;
  for (const raw of fields.split(',')) {
    const name = raw.trim().split('/')[0]!;
    if (!name || BASIC.has(name)) continue;
    if (CONTACT.has(name)) contact = true;
    else if (ATMOSPHERE.has(name)) atmosphere = true;
    else contact = atmosphere = true;
  }
  return [
    ...(contact ? [one('legacy.places.contact_data')] : []),
    ...(atmosphere ? [one('legacy.places.atmosphere_data')] : []),
  ];
}

/** Count of points in a Google encoded polyline (each point is two varint-encoded values). */
export function encodedPolylinePoints(encoded: string): number {
  let values = 0;
  for (let i = 0; i < encoded.length; i++) {
    // A chunk without the continuation bit (0x20) ends one value.
    if (((encoded.charCodeAt(i) - 63) & 0x20) === 0) values++;
  }
  return Math.floor(values / 2);
}

/**
 * Locations in a pipe-separated legacy list. `enc:<polyline>:` entries count every point; a polyline
 * can itself contain `|` but never `:`, so it is matched before splitting.
 */
export function countLocations(param: string | null): number {
  if (!param) return 0;
  let n = 0;
  for (const m of param.matchAll(/enc:([^:]*):|[^|]+/g)) {
    if (m[1] !== undefined) n += encodedPolylinePoints(m[1]);
    else if (m[0].trim()) n++;
  }
  return n;
}

const hasModifier = (param: string | null) =>
  param !== null && param.split('|').some((p) => /^(side_of_road:|heading=)/.test(p.trim()));

/** Directions (Legacy): Advanced for traffic, 11-25 waypoints, optimize:true or location modifiers. */
export function directionsSku(q: URLSearchParams): string {
  const waypoints = q.get('waypoints');
  const parts = waypoints ? waypoints.split('|').filter((p) => p.trim() !== '') : [];
  const optimize = parts[0]?.trim() === 'optimize:true';
  const count = parts.filter((p) => p.trim() !== 'optimize:true').length;
  const advanced =
    q.has('departure_time') ||
    q.has('traffic_model') ||
    count > 10 ||
    optimize ||
    hasModifier(q.get('origin')) ||
    hasModifier(q.get('destination')) ||
    hasModifier(waypoints);
  return advanced ? 'legacy.directions_advanced' : 'legacy.directions';
}

/** Distance Matrix (Legacy): billed per element (origins x destinations). */
export function distanceMatrixItem(q: URLSearchParams): LineItem {
  const advanced =
    q.has('departure_time') ||
    q.has('traffic_model') ||
    hasModifier(q.get('origins')) ||
    hasModifier(q.get('destinations'));
  const elements =
    BigInt(countLocations(q.get('origins'))) * BigInt(countLocations(q.get('destinations')));
  return {
    sku: advanced ? 'legacy.distance_matrix_advanced' : 'legacy.distance_matrix',
    units: elements,
  };
}

/** Legacy JSON statuses of a request that worked (with or without results). */
export const LEGACY_OK_STATUSES = new Set(['OK', 'ZERO_RESULTS']);

/** Legacy JSON statuses that are not a successful request, so Google does not bill them. */
export const LEGACY_UNBILLED_STATUSES = new Set([
  'INVALID_REQUEST',
  'REQUEST_DENIED',
  'OVER_QUERY_LIMIT',
  'OVER_DAILY_LIMIT',
]);
