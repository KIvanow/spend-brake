import { describe, expect, it } from 'vitest';
import { computeRouteMatrixTier, computeRoutesTier } from '../src/google-maps/routes.js';

const wp = (lat = 1, lng = 2) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
const basic = { origin: wp(), destination: wp(3, 4), travelMode: 'DRIVE' };

describe('computeRoutes tier', () => {
  it('is Essentials for a plain request', () => {
    expect(computeRoutesTier(basic).tier).toBe('essentials');
    expect(
      computeRoutesTier({
        ...basic,
        intermediates: Array.from({ length: 10 }, () => wp()),
        routingPreference: 'TRAFFIC_UNAWARE',
        routeModifiers: { avoidTolls: true, avoidFerries: true },
        computeAlternativeRoutes: true,
        languageCode: 'en',
        units: 'METRIC',
      }).tier,
    ).toBe('essentials');
  });

  it.each([
    ['11 intermediate waypoints', { intermediates: Array.from({ length: 11 }, () => wp()) }],
    ['optimizeWaypointOrder', { optimizeWaypointOrder: true }],
    ['TRAFFIC_AWARE', { routingPreference: 'TRAFFIC_AWARE' }],
    ['TRAFFIC_AWARE_OPTIMAL', { routingPreference: 'TRAFFIC_AWARE_OPTIMAL' }],
    ['side of road', { origin: { ...wp(), sideOfRoad: true } }],
    ['vehicle stopover', { destination: { ...wp(), vehicleStopover: true } }],
    ['heading', { origin: { location: { latLng: { latitude: 1, longitude: 2 }, heading: 90 } } }],
  ])('is Pro with %s', (_, extra) => {
    expect(computeRoutesTier({ ...basic, ...extra }).tier).toBe('pro');
  });

  it.each([
    ['two-wheeler', { travelMode: 'TWO_WHEELER' }],
    ['toll calculation', { extraComputations: ['TOLLS'] }],
    ['traffic on polylines', { extraComputations: ['TRAFFIC_ON_POLYLINE'] }],
    ['an unknown field', { someFutureFeature: true }],
    ['an unknown route modifier', { routeModifiers: { vehicleInfo: { emissionType: 'DIESEL' } } }],
    ['an unknown travel mode', { travelMode: 'HOVERCRAFT' }],
  ])('is Enterprise with %s', (_, extra) => {
    expect(computeRoutesTier({ ...basic, ...extra }).tier).toBe('enterprise');
  });

  it('keeps extra computations that are not SKU triggers at Essentials', () => {
    expect(
      computeRoutesTier({
        ...basic,
        extraComputations: ['HTML_FORMATTED_NAVIGATION_INSTRUCTIONS', 'FLYOVER_INFO_ON_POLYLINE'],
      }).tier,
    ).toBe('essentials');
    expect(
      computeRoutesTier({ ...basic, extraComputations: ['FLYOVER_INFO_ON_POLYLINE', 'TOLLS'] })
        .tier,
    ).toBe('enterprise');
    expect(computeRoutesTier({ ...basic, extraComputations: ['SOMETHING_NEW'] }).tier).toBe(
      'enterprise',
    );
  });

  it('Enterprise wins over Pro', () => {
    expect(
      computeRoutesTier({ ...basic, routingPreference: 'TRAFFIC_AWARE', travelMode: 'TWO_WHEELER' })
        .tier,
    ).toBe('enterprise');
  });

  it('prices a missing body at Enterprise', () => {
    expect(computeRoutesTier(undefined).tier).toBe('enterprise');
  });
});

describe('computeRouteMatrix tier', () => {
  const m = (n: number) => Array.from({ length: n }, () => ({ waypoint: wp() }));

  it('counts origins x destinations elements', () => {
    expect(computeRouteMatrixTier({ origins: m(3), destinations: m(4) })).toMatchObject({
      tier: 'essentials',
      elements: 12n,
    });
  });

  it('is Pro with traffic or modifiers, Enterprise with tolls or two-wheelers', () => {
    expect(
      computeRouteMatrixTier({
        origins: m(1),
        destinations: m(1),
        routingPreference: 'TRAFFIC_AWARE',
      }).tier,
    ).toBe('pro');
    expect(
      computeRouteMatrixTier({
        origins: [{ waypoint: { ...wp(), sideOfRoad: true } }],
        destinations: m(1),
      }).tier,
    ).toBe('pro');
    expect(
      computeRouteMatrixTier({ origins: m(1), destinations: m(1), extraComputations: ['TOLLS'] })
        .tier,
    ).toBe('enterprise');
    expect(
      computeRouteMatrixTier({ origins: m(1), destinations: m(1), travelMode: 'TWO_WHEELER' }).tier,
    ).toBe('enterprise');
  });
});
