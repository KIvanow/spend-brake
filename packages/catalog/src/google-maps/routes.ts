// Routes API SKU tiers. Source: https://developers.google.com/maps/billing-and-pricing/sku-details
// (Routes: Compute Routes / Compute Route Matrix Essentials, Pro, Enterprise triggers).
//
// Pro: 11-25 intermediate waypoints, optimizeWaypointOrder, TRAFFIC_AWARE(_OPTIMAL) routing,
//      side-of-road / heading / vehicle-stopover location modifiers.
// Enterprise: two-wheeler routing, toll calculation, traffic on polylines, large vehicle routing.
//
// Anything we do not recognise prices as Enterprise, so an unknown feature can never undercharge.

export type RoutesTier = 'essentials' | 'pro' | 'enterprise';

const ROUTES_KEYS = new Set([
  'origin',
  'destination',
  'intermediates',
  'travelMode',
  'routingPreference',
  'polylineQuality',
  'polylineEncoding',
  'departureTime',
  'arrivalTime',
  'computeAlternativeRoutes',
  'routeModifiers',
  'languageCode',
  'regionCode',
  'units',
  'optimizeWaypointOrder',
  'extraComputations',
  'trafficModel',
  'transitPreferences',
]);

const MATRIX_KEYS = new Set([
  'origins',
  'destinations',
  'travelMode',
  'routingPreference',
  'departureTime',
  'arrivalTime',
  'languageCode',
  'regionCode',
  'units',
  'extraComputations',
  'trafficModel',
  'transitPreferences',
]);

const ESSENTIAL_MODIFIERS = new Set(['avoidTolls', 'avoidHighways', 'avoidFerries', 'avoidIndoor']);
const ESSENTIAL_TRAVEL_MODES = new Set([
  undefined,
  'TRAVEL_MODE_UNSPECIFIED',
  'DRIVE',
  'BICYCLE',
  'WALK',
  'TRANSIT',
]);
const TRAFFIC_AWARE = new Set(['TRAFFIC_AWARE', 'TRAFFIC_AWARE_OPTIMAL']);
const ESSENTIAL_PREFERENCES = new Set([
  undefined,
  'ROUTING_PREFERENCE_UNSPECIFIED',
  'TRAFFIC_UNAWARE',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class TierAcc {
  tier: RoutesTier = 'essentials';
  reasons: string[] = [];
  pro(reason: string) {
    if (this.tier === 'essentials') this.tier = 'pro';
    this.reasons.push(`pro: ${reason}`);
  }
  enterprise(reason: string) {
    this.tier = 'enterprise';
    this.reasons.push(`enterprise: ${reason}`);
  }
}

function checkWaypoint(wp: unknown, where: string, acc: TierAcc) {
  if (!isObj(wp)) return;
  if (wp.sideOfRoad === true) acc.pro(`${where}.sideOfRoad`);
  if (wp.vehicleStopover === true) acc.pro(`${where}.vehicleStopover`);
  if (isObj(wp.location) && wp.location.heading !== undefined) acc.pro(`${where}.location.heading`);
}

function checkModifiers(mods: unknown, where: string, acc: TierAcc) {
  if (mods === undefined) return;
  if (!isObj(mods)) return acc.enterprise(`${where} is not an object`);
  for (const k of Object.keys(mods)) {
    if (!ESSENTIAL_MODIFIERS.has(k)) acc.enterprise(`${where}.${k}`);
  }
}

function checkCommon(body: Obj, acc: TierAcc) {
  const mode = body.travelMode as string | undefined;
  if (mode === 'TWO_WHEELER') acc.enterprise('travelMode TWO_WHEELER');
  else if (!ESSENTIAL_TRAVEL_MODES.has(mode)) acc.enterprise(`travelMode ${String(mode)}`);

  const pref = body.routingPreference as string | undefined;
  if (TRAFFIC_AWARE.has(pref as string)) acc.pro(`routingPreference ${pref}`);
  else if (!ESSENTIAL_PREFERENCES.has(pref)) acc.enterprise(`routingPreference ${String(pref)}`);

  if (body.trafficModel !== undefined) acc.pro('trafficModel');

  const extra = body.extraComputations;
  if (extra !== undefined) {
    // TOLLS and TRAFFIC_ON_POLYLINE are Enterprise; other values are not on the SKU page.
    for (const e of Array.isArray(extra) ? extra : [extra])
      acc.enterprise(`extraComputations ${String(e)}`);
  }
}

export function computeRoutesTier(body: unknown): { tier: RoutesTier; reasons: string[] } {
  const acc = new TierAcc();
  if (!isObj(body)) {
    acc.enterprise('missing body');
    return { tier: acc.tier, reasons: acc.reasons };
  }
  for (const k of Object.keys(body)) if (!ROUTES_KEYS.has(k)) acc.enterprise(`unknown field ${k}`);
  checkCommon(body, acc);
  checkModifiers(body.routeModifiers, 'routeModifiers', acc);

  const intermediates = Array.isArray(body.intermediates) ? body.intermediates : [];
  if (intermediates.length > 10) acc.pro(`${intermediates.length} intermediate waypoints`);
  if (body.optimizeWaypointOrder === true) acc.pro('optimizeWaypointOrder');
  checkWaypoint(body.origin, 'origin', acc);
  checkWaypoint(body.destination, 'destination', acc);
  intermediates.forEach((wp, i) => checkWaypoint(wp, `intermediates[${i}]`, acc));
  return { tier: acc.tier, reasons: acc.reasons };
}

export function computeRouteMatrixTier(body: unknown): {
  tier: RoutesTier;
  reasons: string[];
  elements: bigint;
} {
  const acc = new TierAcc();
  if (!isObj(body)) {
    acc.enterprise('missing body');
    return { tier: acc.tier, reasons: acc.reasons, elements: 0n };
  }
  for (const k of Object.keys(body)) if (!MATRIX_KEYS.has(k)) acc.enterprise(`unknown field ${k}`);
  checkCommon(body, acc);

  const origins = Array.isArray(body.origins) ? body.origins : [];
  const destinations = Array.isArray(body.destinations) ? body.destinations : [];
  for (const [list, name] of [
    [origins, 'origins'],
    [destinations, 'destinations'],
  ] as const) {
    list.forEach((item: unknown, i) => {
      if (!isObj(item)) return;
      checkWaypoint(item.waypoint, `${name}[${i}].waypoint`, acc);
      checkModifiers(item.routeModifiers, `${name}[${i}].routeModifiers`, acc);
    });
  }
  return {
    tier: acc.tier,
    reasons: acc.reasons,
    elements: BigInt(origins.length) * BigInt(destinations.length),
  };
}
