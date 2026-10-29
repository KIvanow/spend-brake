import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { isPriced, priceItems } from '../pricing.js';
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

export const HERE = 'here';

const GEOCODE = 'https://geocode.search.hereapi.com';
const REVGEOCODE = 'https://revgeocode.search.hereapi.com';
const DISCOVER = 'https://discover.search.hereapi.com';
const AUTOSUGGEST = 'https://autosuggest.search.hereapi.com';
const AUTOCOMPLETE = 'https://autocomplete.search.hereapi.com';
const ROUTER = 'https://router.hereapi.com';
const MATRIX = 'https://matrix.router.hereapi.com';

export const HERE_UPSTREAMS = [
  { prefix: '/here-geocode', origin: GEOCODE },
  { prefix: '/here-revgeocode', origin: REVGEOCODE },
  { prefix: '/here-discover', origin: DISCOVER },
  { prefix: '/here-autosuggest', origin: AUTOSUGGEST },
  { prefix: '/here-autocomplete', origin: AUTOCOMPLETE },
  { prefix: '/here-router', origin: ROUTER },
  { prefix: '/here-matrix', origin: MATRIX },
] as const;

const ORIGINS = new Set<string>(HERE_UPSTREAMS.map((u) => u.origin));
const VOLATILE = ['apiKey'];
// Matrix Routing accepts up to 10,000 origins and destinations; more is refused upstream.
const MAX_MATRIX_POINTS = 10_000;

export function loadHereCatalog(): Catalog {
  return parseCatalog(readDataFile('here/catalog.yaml'));
}

/**
 * Matrix Routing transactions: origins x destinations when either is below 5, otherwise 5 x the
 * larger of the two.
 */
export function matrixTransactions(origins: number, destinations: number): number {
  if (origins < 5 || destinations < 5) return origins * destinations;
  return 5 * Math.max(origins, destinations);
}

type Route = { route: string; items: LineItem[] } | { unpriced: string };

const one = (route: string, sku: string): Route => ({ route, items: [{ sku, units: 1n }] });

/**
 * HERE location services on the Base Plan: Geocoding & Search (geocode, reverse geocode,
 * discover, autosuggest, autocomplete), Routing v8 and Matrix Routing v8, priced per transaction.
 */
export class HereAdapter implements ProviderAdapter {
  readonly id = HERE;
  readonly upstreams = HERE_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;

  constructor(opts: { catalog?: Catalog } = {}) {
    this.catalog = opts.catalog ?? loadHereCatalog();
  }

  match(req: IncomingReq): boolean {
    return ORIGINS.has(req.origin);
  }

  classify(req: IncomingReq): Classified {
    const hash = normalizedHash({ ...req, volatile: VOLATILE });
    const r = this.route(req);
    if ('unpriced' in r)
      return { priced: false, provider: HERE, reason: r.unpriced, normalizedHash: hash };
    if (!isPriced(this.catalog.skus, r.items)) {
      return {
        priced: false,
        provider: HERE,
        reason: `no verified price for ${r.route}`,
        normalizedHash: hash,
      };
    }
    return { priced: true, provider: HERE, route: r.route, items: r.items, normalizedHash: hash };
  }

  private route(req: IncomingReq): Route {
    const { method, origin, path, query: q } = req;
    const get = method === 'GET';
    if (get && origin === GEOCODE && path === '/v1/geocode')
      return one('here.geocode', 'here.geocode');
    if (get && origin === REVGEOCODE && path === '/v1/revgeocode') {
      return one('here.revgeocode', 'here.geocode');
    }
    if (get && origin === DISCOVER && path === '/v1/discover')
      return one('here.discover', 'here.discover');
    if (get && origin === AUTOSUGGEST && path === '/v1/autosuggest') {
      return one('here.autosuggest', 'here.autosuggest');
    }
    if (get && origin === AUTOCOMPLETE && path === '/v1/autocomplete') {
      return one('here.autocomplete', 'here.autocomplete');
    }

    if (origin === ROUTER && path === '/v8/routes' && (get || method === 'POST')) {
      // Features with their own price lists (EV routing, toll costs) are not transcribed yet.
      if ([...q.keys()].some((k) => k.startsWith('ev['))) return { unpriced: 'EV routing' };
      if (q.getAll('return').some((v) => v.split(',').includes('tolls'))) {
        return { unpriced: 'toll costs' };
      }
      const mode = q.get('transportMode');
      if (mode === 'truck') return one('here.routing.truck', 'here.routing.truck');
      if (mode === 'car' || mode === 'pedestrian' || mode === 'bicycle') {
        // Without one of these HERE bills the route as time-aware routing.
        const timeless = q.get('departureTime') === 'any' || q.get('traffic[mode]') === 'disabled';
        return timeless
          ? one('here.routing.basic', 'here.routing.basic')
          : one('here.routing.time_aware', 'here.routing.time_aware');
      }
      return { unpriced: `routing transportMode ${mode ?? '(none)'}` };
    }

    if (origin === MATRIX) {
      if (method === 'POST' && path === '/v8/matrix') {
        const body = req.body as { origins?: unknown; destinations?: unknown } | undefined;
        const origins = Array.isArray(body?.origins) ? body.origins.length : 0;
        // Destinations default to the origins.
        const destinations =
          body?.destinations === undefined
            ? origins
            : Array.isArray(body.destinations)
              ? body.destinations.length
              : 0;
        if (origins < 1 || destinations < 1) return { unpriced: 'matrix needs origins' };
        if (origins > MAX_MATRIX_POINTS || destinations > MAX_MATRIX_POINTS) {
          return { unpriced: 'matrix too large' };
        }
        return {
          route: 'here.matrix',
          items: [{ sku: 'here.matrix', units: BigInt(matrixTransactions(origins, destinations)) }],
        };
      }
      // Polling an asynchronous matrix and fetching its result cost nothing more.
      if (get && /^\/v8\/matrix\/[A-Za-z0-9-]+(\/status)?$/.test(path)) {
        return { route: 'here.matrix.poll', items: [{ sku: 'here.matrix', units: 0n }] };
      }
    }
    return { unpriced: `no catalog entry for ${method} ${origin}${path}` };
  }

  billingSession(): null {
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

  /**
   * The secret is an API key (sent as `apiKey`) or `Bearer <OAuth token>` (sent as the
   * Authorization header). Whatever the client sent in either place is dropped.
   */
  injectCredential(req: OutgoingReq, secret: string): void {
    req.query.delete('apiKey');
    delete req.headers.authorization;
    const bearer = /^Bearer (\S+)$/.exec(secret)?.[1];
    if (bearer) req.headers.authorization = `Bearer ${bearer}`;
    else req.query.set('apiKey', secret);
  }

  /** 401 for an unknown key or expired token, 403 for a project without access. */
  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401 || res.status === 403;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
