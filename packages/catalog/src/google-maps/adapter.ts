import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { priceItems, isPriced } from '../pricing.js';
import type {
  BillingSession,
  Classified,
  ClassifyOptions,
  IncomingReq,
  LineItem,
  OutgoingReq,
  PriceCtx,
  PricedClassified,
  ProviderAdapter,
  UpstreamRes,
} from '../types.js';
import {
  LEGACY_UNBILLED_STATUSES,
  directionsSku,
  distanceMatrixItem,
  legacyDataSkus,
} from './legacy.js';
import {
  TIERS,
  type PlacesEndpoint,
  type PlacesFields,
  parsePlacesFields,
  resolveFieldMask,
} from './places.js';
import { computeRouteMatrixTier, computeRoutesTier } from './routes.js';

export const GOOGLE_MAPS = 'google-maps';

const MAPS = 'https://maps.googleapis.com';
const PLACES = 'https://places.googleapis.com';
const ROUTES = 'https://routes.googleapis.com';

export const GOOGLE_MAPS_UPSTREAMS = [
  { prefix: '/google-maps', origin: MAPS },
  { prefix: '/google-places', origin: PLACES },
  { prefix: '/google-routes', origin: ROUTES },
] as const;

// Autocomplete session tokens are short-lived; a session seen again after this counts as new,
// which can only overcharge.
const SESSION_TTL_SEC = 600;

// Never part of the loop-detection hash: credentials and per-session tokens.
const VOLATILE = ['key', 'signature', 'sessiontoken', 'sessionToken'];

export interface GoogleMapsAdapterOptions {
  catalog?: Catalog;
  placesFields?: PlacesFields;
}

export function loadGoogleMapsCatalog(): Catalog {
  return parseCatalog(readDataFile('google-maps/catalog.yaml'));
}

export function loadPlacesFields(): PlacesFields {
  return parsePlacesFields(readDataFile('google-maps/places-fields.yaml'));
}

/**
 * Every field mask the request carries, joined. Google reads one of them, and we cannot be sure
 * which wins, so pricing takes the highest tier across all of them.
 */
function fieldMask(req: IncomingReq): string | undefined {
  const masks = [
    req.headers['x-goog-fieldmask'],
    ...req.query.getAll('fields'),
    ...req.query.getAll('$fields'),
  ].filter((m): m is string => typeof m === 'string' && m.trim() !== '');
  return masks.length === 0 ? undefined : masks.join(',');
}

const PLACE_DETAILS = /^\/v1\/places\/[^/:]+$/;
const PLACE_PHOTO = /^\/v1\/places\/[^/]+\/photos\/[^/]+\/media$/;
const LEGACY_PLACE = /^\/maps\/api\/place\/([a-z]+)\/(json|xml)$/;
const LEGACY = /^\/maps\/api\/(geocode|directions|distancematrix)\/(json|xml)$/;

const ENDPOINT_SKU: Record<PlacesEndpoint, string> = {
  details: 'places.details',
  textSearch: 'places.text_search',
  nearbySearch: 'places.nearby_search',
};

function matrixElements(route: string, body: unknown): bigint | null {
  if (route === 'routes.compute_route_matrix' && Array.isArray(body)) return BigInt(body.length);
  if (route === 'legacy.distance_matrix' && body && typeof body === 'object') {
    const rows = (body as { rows?: { elements?: unknown[] }[] }).rows;
    if (!Array.isArray(rows)) return null;
    return BigInt(
      rows.reduce((n, r) => n + (Array.isArray(r.elements) ? r.elements.length : 0), 0),
    );
  }
  return null;
}

type Route = { route: string; items: LineItem[] } | { unpriced: string };

export class GoogleMapsAdapter implements ProviderAdapter {
  readonly id = GOOGLE_MAPS;
  readonly upstreams = GOOGLE_MAPS_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;
  private readonly fields: PlacesFields;

  constructor(opts: GoogleMapsAdapterOptions = {}) {
    this.catalog = opts.catalog ?? loadGoogleMapsCatalog();
    this.fields = opts.placesFields ?? loadPlacesFields();
  }

  match(req: IncomingReq): boolean {
    return this.upstreams.some((u) => u.origin === req.origin);
  }

  classify(req: IncomingReq, opts: ClassifyOptions = {}): Classified {
    const hash = normalizedHash({
      method: req.method,
      origin: req.origin,
      path: req.path,
      query: req.query,
      body: req.body,
      fieldMask: fieldMask(req),
      volatile: VOLATILE,
    });
    const r = this.route(req, opts);
    if ('unpriced' in r) {
      return { priced: false, provider: this.id, reason: r.unpriced, normalizedHash: hash };
    }
    if (!isPriced(this.catalog.skus, r.items)) {
      return {
        priced: false,
        provider: this.id,
        reason: `no verified price for ${r.items.map((i) => i.sku).join(', ')}`,
        normalizedHash: hash,
      };
    }
    return {
      priced: true,
      provider: this.id,
      route: r.route,
      items: r.items,
      normalizedHash: hash,
    };
  }

  private route(req: IncomingReq, opts: ClassifyOptions): Route {
    const method = req.method.toUpperCase();
    const { origin, path, query: q } = req;

    if (origin === PLACES) {
      const places = (endpoint: PlacesEndpoint, route: string): Route => {
        let { tier } = resolveFieldMask(this.fields, endpoint, fieldMask(req));
        // A Details call that closes an Autocomplete session with any Pro-or-higher field is
        // billed at Enterprise + Atmosphere (SKU page, Place Details Enterprise + Atmosphere).
        if (
          endpoint === 'details' &&
          q.has('sessionToken') &&
          TIERS.indexOf(tier) >= TIERS.indexOf('pro')
        ) {
          tier = 'enterprise_atmosphere';
        }
        return { route, items: [{ sku: `${ENDPOINT_SKU[endpoint]}.${tier}`, units: 1n }] };
      };
      if (method === 'POST' && path === '/v1/places:searchText')
        return places('textSearch', 'places.text_search');
      if (method === 'POST' && path === '/v1/places:searchNearby')
        return places('nearbySearch', 'places.nearby_search');
      if (method === 'POST' && path === '/v1/places:autocomplete') {
        // Session pricing can only lower this, so per-request is the worst case.
        return { route: 'places.autocomplete', items: [{ sku: 'places.autocomplete', units: 1n }] };
      }
      if (method === 'GET' && PLACE_PHOTO.test(path)) {
        return { route: 'places.photo', items: [{ sku: 'places.photo', units: 1n }] };
      }
      if (method === 'GET' && PLACE_DETAILS.test(path)) return places('details', 'places.details');
    }

    if (origin === ROUTES && method === 'POST') {
      if (path === '/directions/v2:computeRoutes') {
        const { tier } = computeRoutesTier(req.body);
        return {
          route: 'routes.compute_routes',
          items: [{ sku: `routes.compute_routes.${tier}`, units: 1n }],
        };
      }
      if (path === '/distanceMatrix/v2:computeRouteMatrix') {
        const { tier, elements } = computeRouteMatrixTier(req.body);
        // Unknown size means unknown price: never reserve zero for a billed-per-element call.
        if (elements === 0n) {
          return { unpriced: 'route matrix without readable origins and destinations' };
        }
        return {
          route: 'routes.compute_route_matrix',
          items: [{ sku: `routes.compute_route_matrix.${tier}`, units: elements }],
        };
      }
    }

    if (origin === MAPS && method === 'GET') {
      const legacy = LEGACY.exec(path);
      if (legacy?.[1] === 'geocode')
        return { route: 'geocoding', items: [{ sku: 'geocoding', units: 1n }] };
      if (legacy?.[1] === 'directions') {
        return { route: 'legacy.directions', items: [{ sku: directionsSku(q), units: 1n }] };
      }
      if (legacy?.[1] === 'distancematrix') {
        const item = distanceMatrixItem(q);
        if (item.units === 0n)
          return { unpriced: 'distance matrix without origins or destinations' };
        return { route: 'legacy.distance_matrix', items: [item] };
      }
      const place = LEGACY_PLACE.exec(path)?.[1];
      const base = (sku: string, extra: LineItem[] = []): Route => ({
        route: `legacy.places.${place}`,
        items: [{ sku, units: 1n }, ...extra],
      });
      switch (place) {
        case 'autocomplete':
          if (!q.has('sessiontoken')) return base('legacy.places.autocomplete');
          // Billed once per session: the first request carries the session price, the rest are
          // free. A session closed by Place Details is free here too, but we cannot know that up
          // front, so the first request keeps the abandoned-session price.
          return {
            route: 'legacy.places.autocomplete',
            items: [
              {
                sku: 'legacy.places.autocomplete_session',
                units: opts.billingSessionStarted ? 0n : 1n,
              },
            ],
          };
        case 'queryautocomplete':
          return base('legacy.places.query_autocomplete');
        case 'findplacefromtext': {
          const fields = q.get('fields');
          const onlyId = !fields || fields.split(',').every((f) => f.trim() === 'place_id');
          return onlyId
            ? base('legacy.places.find_place_id_only')
            : base('legacy.places.find_place', legacyDataSkus(fields));
        }
        case 'details':
          return base('legacy.places.details', legacyDataSkus(q.get('fields')));
        // Text and Nearby Search (Legacy) take no field list and return every data category.
        case 'textsearch':
          return base('legacy.places.text_search', legacyDataSkus(null));
        case 'nearbysearch':
          return base('legacy.places.nearby_search', legacyDataSkus(null));
      }
      if (path === '/maps/api/place/photo') {
        return { route: 'legacy.places.photo', items: [{ sku: 'legacy.places.photo', units: 1n }] };
      }
    }

    return { unpriced: `no catalog entry for ${method} ${origin}${path}` };
  }

  billingSession(req: IncomingReq): BillingSession | null {
    const token = req.query.get('sessiontoken');
    if (req.origin !== MAPS || !token || !req.path.startsWith('/maps/api/place/autocomplete/')) {
      return null;
    }
    return { token, ttlSec: SESSION_TTL_SEC };
  }

  needsBody(c: PricedClassified): boolean {
    // Legacy APIs report errors in a JSON status; matrices may settle on returned elements.
    if (c.route === 'legacy.places.photo') return false;
    return (
      c.route.startsWith('legacy.') ||
      c.route === 'geocoding' ||
      c.route === 'routes.compute_route_matrix'
    );
  }

  worstCase(c: PricedClassified, ctx: PriceCtx): bigint {
    return priceItems(this.catalog.skus, c.items, ctx);
  }

  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint {
    if (!this.billedOnStatus(res.status, c)) return 0n;
    const body = res.body;
    if (c.route.startsWith('legacy.') || c.route === 'geocoding') {
      const status = (body as { status?: unknown } | undefined)?.status;
      if (typeof status === 'string' && LEGACY_UNBILLED_STATUSES.has(status)) return 0n;
    }
    // Matrices bill origins x destinations, and every element comes back (unroutable ones
    // carry a condition), so a short body means a cut-off response, not a smaller bill. Only
    // more elements than requested can change the price.
    const returned = matrixElements(c.route, body);
    if (returned !== null && returned > c.items[0]!.units) {
      return priceItems(this.catalog.skus, [{ sku: c.items[0]!.sku, units: returned }], ctx);
    }
    return this.worstCase(c, ctx);
  }

  injectCredential(req: OutgoingReq, secret: string): void {
    req.query.delete('key');
    delete req.headers['x-goog-api-key'];
    if (req.origin === MAPS) req.query.set('key', secret);
    else req.headers['x-goog-api-key'] = secret;
  }

  billedOnStatus(status: number, c?: PricedClassified): boolean {
    if (status >= 200 && status < 300) return true;
    // Photo endpoints answer a successful (billed) request with a redirect to the image.
    const photo = c?.route === 'places.photo' || c?.route === 'legacy.places.photo';
    return photo && status >= 300 && status < 400;
  }
}
