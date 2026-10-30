import { type Catalog, parseCatalog, readDataFile } from '../catalog.js';
import { normalizedHash } from '../hash.js';
import { priceItems } from '../pricing.js';
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
import { type Route, capped, classified, intIn, object, one } from './common.js';

export const TAVILY = 'tavily';
const API = 'https://api.tavily.com';
export const TAVILY_UPSTREAMS = [{ prefix: '/tavily', origin: API }] as const;

const MAX_EXTRACT_URLS = 20;
// Map and crawl stop after `limit` pages (default 50); Tavily sets no maximum, so neither do we.
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100_000;
const BASIC_DEPTHS = new Set(['basic', 'fast', 'ultra-fast']);

export function loadTavilyCatalog(): Catalog {
  return parseCatalog(readDataFile('tavily/catalog.yaml'));
}

function extractSku(depth: unknown): string | null {
  if (depth === undefined || depth === 'basic') return 'tavily.extract.basic';
  if (depth === 'advanced') return 'tavily.extract.advanced';
  return null;
}

function mapSku(instructions: unknown): string {
  return typeof instructions === 'string' && instructions.trim() !== ''
    ? 'tavily.map.instructions'
    : 'tavily.map';
}

/**
 * Tavily: search, extract, map, crawl and research, priced in credits at the pay-as-you-go rate.
 * The worst case is reserved from the request body; successful responses settle from the units
 * Tavily reports (credits, extracted URLs, mapped pages), never above it.
 */
export class TavilyAdapter implements ProviderAdapter {
  readonly id = TAVILY;
  readonly upstreams = TAVILY_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;

  constructor(opts: { catalog?: Catalog } = {}) {
    this.catalog = opts.catalog ?? loadTavilyCatalog();
  }

  match(req: IncomingReq): boolean {
    return req.origin === API;
  }

  classify(req: IncomingReq): Classified {
    return classified(TAVILY, this.catalog, this.route(req), normalizedHash(req));
  }

  private route(req: IncomingReq): Route {
    const { method, path } = req;
    // Reading usage and polling a research task cost nothing.
    if (method === 'GET' && path === '/usage')
      return one('tavily.usage', 'tavily.search.basic', 0n);
    if (method === 'GET' && /^\/research\/[A-Za-z0-9-]+$/.test(path)) {
      return one('tavily.research.poll', 'tavily.research.pro', 0n);
    }
    if (method !== 'POST') return { unpriced: `no catalog entry for ${method} ${API}${path}` };
    const body = object(req.body);
    if (!body) return { unpriced: 'Tavily requests need a JSON object body' };
    // The key goes in the Authorization header; a body key would reach Tavily as sent.
    if ('api_key' in body) return { unpriced: 'send the key as a Bearer token, not in the body' };

    switch (path) {
      case '/search': {
        const depth = body.search_depth;
        if (depth !== undefined && depth !== 'advanced' && !BASIC_DEPTHS.has(depth as string)) {
          return { unpriced: 'unknown search_depth' };
        }
        // auto_parameters costs 2 credits unless the depth is set to a 1-credit one.
        const advanced = depth === 'advanced' || (body.auto_parameters === true && !depth);
        return advanced
          ? one('tavily.search', 'tavily.search.advanced')
          : one('tavily.search', 'tavily.search.basic');
      }
      case '/extract': {
        const urls = typeof body.urls === 'string' ? [body.urls] : body.urls;
        if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_EXTRACT_URLS) {
          return { unpriced: 'extract needs 1 to 20 urls' };
        }
        const sku = extractSku(body.extract_depth);
        if (!sku) return { unpriced: 'unknown extract_depth' };
        return one('tavily.extract', sku, BigInt(urls.length));
      }
      case '/map':
      case '/crawl': {
        const limit = intIn(body.limit, 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT);
        if (limit === null) return { unpriced: 'limit must be a positive integer' };
        const items: LineItem[] = [{ sku: mapSku(body.instructions), units: BigInt(limit) }];
        if (path === '/crawl') {
          const sku = extractSku(body.extract_depth);
          if (!sku) return { unpriced: 'unknown extract_depth' };
          items.push({ sku, units: BigInt(limit) });
        }
        return { route: `tavily${path.replace('/', '.')}`, items };
      }
      case '/research': {
        const model = body.model;
        if (model === 'mini') return one('tavily.research', 'tavily.research.mini');
        if (model === undefined || model === 'pro' || model === 'auto') {
          return one('tavily.research', 'tavily.research.pro');
        }
        return { unpriced: 'unknown research model' };
      }
      default:
        return { unpriced: `no catalog entry for ${method} ${API}${path}` };
    }
  }

  billingSession(): null {
    return null;
  }

  needsBody(c: PricedClassified): boolean {
    return ['tavily.search', 'tavily.extract', 'tavily.map', 'tavily.crawl'].includes(c.route);
  }

  worstCase(c: PricedClassified, ctx: PriceCtx): bigint {
    return priceItems(this.catalog.skus, c.items, ctx);
  }

  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint {
    if (!this.billedOnStatus(res.status)) return 0n;
    const body = object(res.body);
    const results = Array.isArray(body?.results) ? body.results.length : null;
    const usage = object(body?.usage)?.credits;
    switch (c.route) {
      case 'tavily.search':
        if (usage === 1)
          return capped(this.catalog, c, [{ sku: 'tavily.search.basic', units: 1n }], ctx);
        break;
      case 'tavily.extract':
      case 'tavily.map':
        // Failed URLs and pages are not charged.
        if (results !== null) {
          return capped(this.catalog, c, [{ sku: c.items[0]!.sku, units: BigInt(results) }], ctx);
        }
        break;
      case 'tavily.crawl':
        // Mapping may visit more pages than it returns; only the extraction settles lower.
        if (results !== null) {
          return capped(
            this.catalog,
            c,
            [c.items[0]!, { sku: c.items[1]!.sku, units: BigInt(results) }],
            ctx,
          );
        }
        break;
    }
    return this.worstCase(c, ctx);
  }

  injectCredential(req: OutgoingReq, secret: string): void {
    req.headers.authorization = `Bearer ${secret}`;
  }

  /** 401 for a missing or invalid key. */
  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
