import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { priceItems } from '../pricing.js';
import type {
  Classified,
  IncomingReq,
  OutgoingReq,
  PriceCtx,
  PricedClassified,
  ProviderAdapter,
  UpstreamRes,
} from '../types.js';
import { type Route, classified, one } from './common.js';

export const SERPAPI = 'serpapi';
const API = 'https://serpapi.com';
export const SERPAPI_UPSTREAMS = [{ prefix: '/serpapi', origin: API }] as const;

export const SERPAPI_PLANS = [
  'starter',
  'developer',
  'production',
  'big_data',
  'searcher',
  'volume',
  'infrastructure',
  'cloud_1m',
] as const;
export type SerpApiPlan = (typeof SERPAPI_PLANS)[number];

/**
 * SerpApi's speed modes are an account setting the request does not show: Ludicrous Speed bills
 * each search 2x, Ludicrous Speed Max 4x.
 */
export const SERPAPI_SPEEDS = { normal: 1n, ludicrous: 2n, ludicrous_max: 4n } as const;
export type SerpApiSpeed = keyof typeof SERPAPI_SPEEDS;

export function loadSerpApiCatalog(): Catalog {
  return parseCatalog(readDataFile('serpapi/catalog.yaml'));
}

/**
 * SerpApi: every engine on `/search` is one search, priced at the org's plan (fee / searches).
 * Archived results, account and locations lookups are free.
 */
export class SerpApiAdapter implements ProviderAdapter {
  readonly id = SERPAPI;
  readonly upstreams = SERPAPI_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;
  private readonly sku: string;
  private readonly searchUnits: bigint;

  constructor(opts: { catalog?: Catalog; plan?: SerpApiPlan; speed?: SerpApiSpeed } = {}) {
    this.catalog = opts.catalog ?? loadSerpApiCatalog();
    this.sku = `serpapi.search.${opts.plan ?? 'starter'}`;
    this.searchUnits = SERPAPI_SPEEDS[opts.speed ?? 'normal'];
    if (!this.catalog.skus.has(this.sku)) throw new Error(`unknown SerpApi plan ${opts.plan}`);
  }

  match(req: IncomingReq): boolean {
    return req.origin === API;
  }

  classify(req: IncomingReq): Classified {
    return classified(
      SERPAPI,
      this.catalog,
      this.route(req),
      normalizedHash({ ...req, volatile: ['api_key'] }),
    );
  }

  private route(req: IncomingReq): Route {
    const { method, path } = req;
    if (method !== 'GET') return { unpriced: `no catalog entry for ${method} ${API}${path}` };
    if (/^\/search(\.json|\.html)?$/.test(path)) {
      return one('serpapi.search', this.sku, this.searchUnits);
    }
    if (
      /^\/searches\/[A-Za-z0-9]+(\.json|\.html)?$/.test(path) ||
      /^\/account(\.json)?$/.test(path) ||
      path === '/locations.json'
    ) {
      return one('serpapi.free', this.sku, 0n);
    }
    return { unpriced: `no catalog entry for ${method} ${API}${path}` };
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

  injectCredential(req: OutgoingReq, secret: string): void {
    req.query.set('api_key', secret);
  }

  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
