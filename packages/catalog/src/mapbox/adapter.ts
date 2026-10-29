import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { isPriced, priceItems } from '../pricing.js';
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

export const MAPBOX = 'mapbox';
const API = 'https://api.mapbox.com';
export const MAPBOX_UPSTREAMS = [{ prefix: '/mapbox', origin: API }] as const;

// A Search Box session ends 180 s after its last /suggest, at /retrieve, or after 50 /suggest
// calls; each completed session is billed once.
const SESSION_IDLE_SEC = 180;
const SUGGESTS_PER_SESSION = 50;
const MAX_BATCH = 1000;
// Coordinates per Matrix request; Mapbox allows 25 (10 for driving-traffic).
const MAX_MATRIX_COORDS = 25;

const VOLATILE = ['access_token', 'session_token'];

export function loadMapboxCatalog(): Catalog {
  return parseCatalog(readDataFile('mapbox/catalog.yaml'));
}

type Route = { route: string; items: LineItem[] } | { unpriced: string };

const one = (route: string, sku: string): Route => ({ route, items: [{ sku, units: 1n }] });

function isTrue(v: string | null): boolean {
  return v !== null && /^(true|1)$/i.test(v);
}

/** Indices list (`0;2;3`) or `all` over `n` coordinates; null when malformed. */
function selection(value: string | null, n: number): number | null {
  if (value === null || value === 'all') return n;
  const parts = value.split(';');
  if (!parts.every((p) => /^\d+$/.test(p) && Number(p) < n)) return null;
  return parts.length;
}

/**
 * Mapbox web services: Geocoding (v6, and v5 places), Directions, Matrix, Search Box and Static
 * Images, priced per request (Matrix per element, Search Box /suggest and /retrieve per session).
 * Client-side GL, tiles and styles are out of scope.
 */
export class MapboxAdapter implements ProviderAdapter {
  readonly id = MAPBOX;
  readonly upstreams = MAPBOX_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;

  constructor(opts: { catalog?: Catalog } = {}) {
    this.catalog = opts.catalog ?? loadMapboxCatalog();
  }

  match(req: IncomingReq): boolean {
    return req.origin === API;
  }

  classify(req: IncomingReq, opts: ClassifyOptions = {}): Classified {
    const hash = normalizedHash({ ...req, volatile: VOLATILE });
    const r = this.route(req, opts);
    if ('unpriced' in r)
      return { priced: false, provider: MAPBOX, reason: r.unpriced, normalizedHash: hash };
    if (!isPriced(this.catalog.skus, r.items)) {
      return {
        priced: false,
        provider: MAPBOX,
        reason: `no verified price for ${r.route}`,
        normalizedHash: hash,
      };
    }
    return { priced: true, provider: MAPBOX, route: r.route, items: r.items, normalizedHash: hash };
  }

  private route(req: IncomingReq, opts: ClassifyOptions): Route {
    const { method, path, query: q } = req;
    const get = method === 'GET';
    const geocodeSku = (permanent: boolean) =>
      permanent ? 'mapbox.geocoding.permanent' : 'mapbox.geocoding.temporary';

    // Geocoding v6.
    if (get && (path === '/search/geocode/v6/forward' || path === '/search/geocode/v6/reverse')) {
      return one('mapbox.geocoding', geocodeSku(isTrue(q.get('permanent'))));
    }
    if (method === 'POST' && path === '/search/geocode/v6/batch') {
      const n = Array.isArray(req.body) ? req.body.length : 0;
      if (n < 1 || n > MAX_BATCH) return { unpriced: 'batch geocoding needs a JSON array body' };
      return {
        route: 'mapbox.geocoding.batch',
        items: [{ sku: geocodeSku(isTrue(q.get('permanent'))), units: BigInt(n) }],
      };
    }
    // Geocoding v5: the endpoint picks storage; permanent requests may batch queries with `;`.
    const v5 = /^\/geocoding\/v5\/(mapbox\.places|mapbox\.places-permanent)\/([^/]+)\.json$/.exec(
      path,
    );
    if (get && v5) {
      const permanent = v5[1] === 'mapbox.places-permanent';
      const n = permanent ? decodeURIComponent(v5[2]!).split(';').length : 1;
      if (n > 50) return { unpriced: 'more than 50 batch queries' };
      return {
        route: 'mapbox.geocoding',
        items: [{ sku: geocodeSku(permanent), units: BigInt(n) }],
      };
    }

    // Directions: one request whatever the profile or number of waypoints.
    if (/^\/directions\/v5\/mapbox\/(driving-traffic|driving|walking|cycling)\/[^/]+$/.test(path)) {
      if (get || method === 'POST') return one('mapbox.directions', 'mapbox.directions');
    }

    // Matrix: sources x destinations elements.
    const matrix =
      /^\/directions-matrix\/v1\/mapbox\/(driving-traffic|driving|walking|cycling)\/([^/]+)$/.exec(
        path,
      );
    if (get && matrix) {
      const n = decodeURIComponent(matrix[2]!).split(';').length;
      if (n < 2 || n > MAX_MATRIX_COORDS) return { unpriced: 'matrix needs 2 to 25 coordinates' };
      const sources = selection(q.get('sources'), n);
      const destinations = selection(q.get('destinations'), n);
      if (sources === null || destinations === null) {
        return { unpriced: 'malformed matrix sources or destinations' };
      }
      return {
        route: 'mapbox.matrix',
        items: [{ sku: 'mapbox.matrix', units: BigInt(sources * destinations) }],
      };
    }

    // Search Box.
    if (get && path === '/search/searchbox/v1/suggest') {
      if (!q.get('session_token')) return { unpriced: 'Search Box /suggest needs a session_token' };
      // The first /suggest of a session (and every 50th) opens a billed session.
      const calls = opts.billingSessionCalls ?? (opts.billingSessionStarted ? 1 : 0);
      return {
        route: 'mapbox.searchbox.suggest',
        items: [
          { sku: 'mapbox.searchbox.session', units: calls % SUGGESTS_PER_SESSION === 0 ? 1n : 0n },
        ],
      };
    }
    if (get && /^\/search\/searchbox\/v1\/retrieve\/[^/]+$/.test(path)) {
      if (!q.get('session_token'))
        return { unpriced: 'Search Box /retrieve needs a session_token' };
      // Closes the session it belongs to; a /retrieve without one is a session of its own.
      const started = (opts.billingSessionCalls ?? 0) > 0 || opts.billingSessionStarted === true;
      return {
        route: 'mapbox.searchbox.retrieve',
        items: [{ sku: 'mapbox.searchbox.session', units: started ? 0n : 1n }],
      };
    }
    if (
      get &&
      (path === '/search/searchbox/v1/forward' ||
        path === '/search/searchbox/v1/reverse' ||
        /^\/search\/searchbox\/v1\/category\/[^/]+$/.test(path))
    ) {
      return one('mapbox.searchbox.request', 'mapbox.searchbox.request');
    }

    // Static Images (not Static Tiles, which are tiles and out of scope).
    if (get && /^\/styles\/v1\/[^/]+\/[^/]+\/static\/.+/.test(path)) {
      return one('mapbox.static_images', 'mapbox.static_images');
    }

    return { unpriced: `no catalog entry for ${method} ${API}${path}` };
  }

  billingSession(req: IncomingReq): BillingSession | null {
    const token = req.query.get('session_token');
    if (req.origin !== API || !token) return null;
    if (req.path === '/search/searchbox/v1/suggest') {
      return { token, ttlSec: SESSION_IDLE_SEC, sliding: true };
    }
    if (req.path.startsWith('/search/searchbox/v1/retrieve/')) {
      return { token, ttlSec: SESSION_IDLE_SEC, ends: true };
    }
    return null;
  }

  needsBody(): boolean {
    return false;
  }

  worstCase(c: PricedClassified, ctx: PriceCtx): bigint {
    return priceItems(this.catalog.skus, c.items, ctx);
  }

  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint {
    return this.billedOnStatus(res.status) ? this.worstCase(c, ctx) : 0n;
  }

  /** The token is a query parameter on every web service. */
  injectCredential(req: OutgoingReq, secret: string): void {
    delete req.headers.authorization;
    req.query.set('access_token', secret);
  }

  /** 401 for a bad or revoked token, 403 for a token without the scope or URL restriction. */
  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401 || res.status === 403;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
