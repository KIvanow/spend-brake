import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { priceItems, isPriced } from '../pricing.js';
import type {
  Classified,
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

function fieldMask(req: IncomingReq): string | undefined {
  return (
    req.headers['x-goog-fieldmask'] ??
    req.query.get('fields') ??
    req.query.get('$fields') ??
    undefined
  );
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

  classify(req: IncomingReq): Classified {
    const hash = normalizedHash({
      method: req.method,
      origin: req.origin,
      path: req.path,
      query: req.query,
      body: req.body,
      fieldMask: fieldMask(req),
      volatile: VOLATILE,
    });
    const r = this.route(req);
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

  private route(req: IncomingReq): Route {
    const method = req.method.toUpperCase();
    const { origin, path, query: q } = req;

    if (origin === PLACES) {
      const places = (endpoint: PlacesEndpoint, route: string): Route => {
        const { tier } = resolveFieldMask(this.fields, endpoint, fieldMask(req));
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
        return { route: 'legacy.distance_matrix', items: [distanceMatrixItem(q)] };
      }
      const place = LEGACY_PLACE.exec(path)?.[1];
      const base = (sku: string, extra: LineItem[] = []): Route => ({
        route: `legacy.places.${place}`,
        items: [{ sku, units: 1n }, ...extra],
      });
      switch (place) {
        case 'autocomplete':
          return base(
            q.has('sessiontoken')
              ? 'legacy.places.autocomplete_session'
              : 'legacy.places.autocomplete',
          );
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

  worstCase(c: PricedClassified, ctx: PriceCtx): bigint {
    return priceItems(this.catalog.skus, c.items, ctx);
  }

  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint {
    if (!this.billedOnStatus(res.status)) return 0n;
    const body = res.body;
    if (c.route.startsWith('legacy.') || c.route === 'geocoding') {
      const status = (body as { status?: unknown } | undefined)?.status;
      if (typeof status === 'string' && LEGACY_UNBILLED_STATUSES.has(status)) return 0n;
    }
    // Matrix calls bill per returned element; without the body we keep the worst case.
    if (c.route === 'routes.compute_route_matrix' && Array.isArray(body)) {
      return priceItems(
        this.catalog.skus,
        [{ sku: c.items[0]!.sku, units: BigInt(body.length) }],
        ctx,
      );
    }
    if (c.route === 'legacy.distance_matrix' && body && typeof body === 'object') {
      const rows = (body as { rows?: { elements?: unknown[] }[] }).rows;
      if (Array.isArray(rows)) {
        const elements = rows.reduce(
          (n, r) => n + (Array.isArray(r.elements) ? r.elements.length : 0),
          0,
        );
        return priceItems(
          this.catalog.skus,
          [{ sku: c.items[0]!.sku, units: BigInt(elements) }],
          ctx,
        );
      }
    }
    return this.worstCase(c, ctx);
  }

  injectCredential(req: OutgoingReq, secret: string): void {
    req.query.delete('key');
    delete req.headers['x-goog-api-key'];
    if (req.origin === MAPS) req.query.set('key', secret);
    else req.headers['x-goog-api-key'] = secret;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
