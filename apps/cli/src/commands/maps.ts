import type { Command } from 'commander';
import { CliError, EXIT, type Io } from '../io.js';
import { type ProxyRequest, proxyCall, report } from '../proxy.js';

// Cheapest useful field set per endpoint (see the catalog's places-fields.yaml). Text Search IDs
// are free; Nearby Search starts at Pro, so its default takes Pro fields only; Place Details
// stays in Essentials. --fields opts into higher tiers.
export const DEFAULT_FIELDS = {
  search: 'places.id,places.name',
  nearby: 'places.id,places.displayName,places.formattedAddress,places.location',
  details: 'id,formattedAddress,location,types',
  route: 'routes.duration,routes.distanceMeters',
} as const;

const LAT_LNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function waypoint(value: string) {
  const m = LAT_LNG.exec(value);
  return m
    ? { location: { latLng: { latitude: Number(m[1]), longitude: Number(m[2]) } } }
    : { address: value };
}

function number(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`${name} must be a number`, EXIT.usage);
  return n;
}

const TRAVEL_MODES = {
  drive: 'DRIVE',
  walk: 'WALK',
  bicycle: 'BICYCLE',
  transit: 'TRANSIT',
} as const;

export type MapsCall =
  | { op: 'search'; query: string; fields?: string; limit?: string }
  | { op: 'nearby'; lat: string; lng: string; radius?: string; type?: string[]; fields?: string }
  | { op: 'details'; placeId: string; fields?: string }
  | { op: 'geocode'; address: string }
  | { op: 'reverse'; lat: string; lng: string }
  | { op: 'route'; origin: string; destination: string; mode?: string; fields?: string };

/** The request `brake maps` sends, cheapest field set unless `fields` says otherwise. */
export function mapsRequest(a: MapsCall): ProxyRequest {
  switch (a.op) {
    case 'search':
      return {
        method: 'POST',
        path: '/google-places/v1/places:searchText',
        headers: { 'x-goog-fieldmask': a.fields ?? DEFAULT_FIELDS.search },
        body: {
          textQuery: a.query,
          ...(a.limit ? { pageSize: number(a.limit, '--limit') } : {}),
        },
      };
    case 'nearby':
      return {
        method: 'POST',
        path: '/google-places/v1/places:searchNearby',
        headers: { 'x-goog-fieldmask': a.fields ?? DEFAULT_FIELDS.nearby },
        body: {
          locationRestriction: {
            circle: {
              center: { latitude: number(a.lat, '--lat'), longitude: number(a.lng, '--lng') },
              radius: number(a.radius ?? '500', '--radius'),
            },
          },
          ...(a.type ? { includedTypes: a.type } : {}),
        },
      };
    case 'details':
      if (!/^[A-Za-z0-9_-]+$/.test(a.placeId)) throw new CliError('invalid place id', EXIT.usage);
      return {
        method: 'GET',
        path: `/google-places/v1/places/${a.placeId}`,
        headers: { 'x-goog-fieldmask': a.fields ?? DEFAULT_FIELDS.details },
      };
    case 'geocode':
      return {
        method: 'GET',
        path: '/google-maps/maps/api/geocode/json',
        query: { address: a.address },
      };
    case 'reverse':
      return {
        method: 'GET',
        path: '/google-maps/maps/api/geocode/json',
        query: { latlng: `${number(a.lat, 'lat')},${number(a.lng, 'lng')}` },
      };
    case 'route': {
      const mode = TRAVEL_MODES[(a.mode ?? 'drive') as keyof typeof TRAVEL_MODES];
      if (!mode) throw new CliError(`unknown --mode ${a.mode}`, EXIT.usage);
      return {
        method: 'POST',
        path: '/google-routes/directions/v2:computeRoutes',
        headers: { 'x-goog-fieldmask': a.fields ?? DEFAULT_FIELDS.route },
        body: {
          origin: waypoint(a.origin),
          destination: waypoint(a.destination),
          travelMode: mode,
        },
      };
    }
  }
}

/** Every leaf command also takes --pretty after its arguments (options are positional). */
function leaf(parent: Command, name: string): Command {
  return parent.command(name).option('--pretty', 'human-readable output instead of JSON');
}

export function mapsCommand(program: Command, io: Io, done: (code: number) => void): void {
  const maps = program
    .command('maps')
    .description('Capped Google Maps calls with the cheapest fields by default; prints the cost');

  const run = async (req: ProxyRequest, pretty: boolean) =>
    done(report(io, await proxyCall(io, req), pretty));
  const pretty = (cmd: Command) => Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty);

  leaf(maps, 'search')
    .description('Places Text Search (New); IDs only unless --fields asks for more')
    .argument('<query...>')
    .option('--fields <mask>', 'X-Goog-FieldMask', DEFAULT_FIELDS.search)
    .option('--limit <n>', 'page size (1-20)')
    .action(async (query: string[], o: { fields: string; limit?: string }, cmd: Command) => {
      await run(
        mapsRequest({
          op: 'search',
          query: query.join(' '),
          fields: o.fields,
          ...(o.limit !== undefined ? { limit: o.limit } : {}),
        }),
        pretty(cmd),
      );
    });

  leaf(maps, 'nearby')
    .description('Places Nearby Search (New) around a point')
    .requiredOption('--lat <lat>')
    .requiredOption('--lng <lng>')
    .option('--radius <m>', 'metres', '500')
    .option('--type <type...>', 'included place types')
    .option('--fields <mask>', 'X-Goog-FieldMask', DEFAULT_FIELDS.nearby)
    .action(
      async (
        o: { lat: string; lng: string; radius: string; type?: string[]; fields: string },
        cmd: Command,
      ) => {
        await run(
          mapsRequest({
            op: 'nearby',
            lat: o.lat,
            lng: o.lng,
            radius: o.radius,
            fields: o.fields,
            ...(o.type ? { type: o.type } : {}),
          }),
          pretty(cmd),
        );
      },
    );

  leaf(maps, 'details')
    .description('Place Details (New); Essentials fields unless --fields asks for more')
    .argument('<placeId>')
    .option('--fields <mask>', 'X-Goog-FieldMask', DEFAULT_FIELDS.details)
    .action(async (placeId: string, o: { fields: string }, cmd: Command) => {
      await run(mapsRequest({ op: 'details', placeId, fields: o.fields }), pretty(cmd));
    });

  leaf(maps, 'geocode')
    .description('Address to coordinates (Geocoding API)')
    .argument('<address...>')
    .action(async (address: string[], _o: unknown, cmd: Command) => {
      await run(mapsRequest({ op: 'geocode', address: address.join(' ') }), pretty(cmd));
    });

  leaf(maps, 'reverse')
    .description('Coordinates to address (Geocoding API)')
    .argument('<lat>')
    .argument('<lng>')
    .action(async (lat: string, lng: string, _o: unknown, cmd: Command) => {
      await run(mapsRequest({ op: 'reverse', lat, lng }), pretty(cmd));
    });

  leaf(maps, 'route')
    .description('Route between two places (Routes API computeRoutes, Essentials by default)')
    .argument('<origin>', 'address or "lat,lng"')
    .argument('<destination>', 'address or "lat,lng"')
    .option('--mode <mode>', 'drive | walk | bicycle | transit', 'drive')
    .option('--fields <mask>', 'X-Goog-FieldMask', DEFAULT_FIELDS.route)
    .action(
      async (
        origin: string,
        destination: string,
        o: { mode: string; fields: string },
        cmd: Command,
      ) => {
        await run(
          mapsRequest({
            op: 'route',
            origin,
            destination,
            mode: o.mode,
            fields: o.fields,
          }),
          pretty(cmd),
        );
      },
    );
}
