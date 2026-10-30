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
import { type Route, classified, intIn, object, one } from './common.js';

export const EXA = 'exa';
const API = 'https://api.exa.ai';
export const EXA_UPSTREAMS = [{ prefix: '/exa', origin: API }] as const;

const INCLUDED_RESULTS = 10;
const MAX_RESULTS = 100;
const MAX_CONTENT_URLS = 1000;
const SEARCH_SKUS: Record<string, string> = {
  lite: 'exa.search.lite',
  instant: 'exa.search.lite',
  auto: 'exa.search.auto',
  fast: 'exa.search.auto',
  'deep-lite': 'exa.search.deep',
  deep: 'exa.search.deep',
  'deep-reasoning': 'exa.search.deep_reasoning',
};
const CONTENT_TYPES = ['text', 'highlights', 'summary'] as const;

export function loadExaCatalog(): Catalog {
  return parseCatalog(readDataFile('exa/catalog.yaml'));
}

/**
 * Content types a request asks for, each billed per page. Search takes them under `contents`;
 * older clients put them at the top level, so either place counts.
 */
function contentTypes(body: Record<string, unknown>): number {
  const contents = object(body.contents) ?? {};
  return CONTENT_TYPES.filter((t) => {
    const v = contents[t] ?? body[t];
    return v !== undefined && v !== false && v !== null;
  }).length;
}

function subpages(body: Record<string, unknown>): boolean {
  const contents = object(body.contents) ?? {};
  const n = contents.subpages ?? body.subpages;
  return n !== undefined && n !== 0 && n !== null;
}

/**
 * Exa: search (by type, results above 10 and contents per page), contents and answer. Exa reports
 * each request's cost in `costDollars`, which settles it when the response is JSON.
 */
export class ExaAdapter implements ProviderAdapter {
  readonly id = EXA;
  readonly upstreams = EXA_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;

  constructor(opts: { catalog?: Catalog } = {}) {
    this.catalog = opts.catalog ?? loadExaCatalog();
  }

  match(req: IncomingReq): boolean {
    return req.origin === API;
  }

  classify(req: IncomingReq): Classified {
    return classified(EXA, this.catalog, this.route(req), normalizedHash(req));
  }

  private route(req: IncomingReq): Route {
    const { method, path } = req;
    if (method !== 'POST' || !['/search', '/contents', '/answer'].includes(path)) {
      return { unpriced: `no catalog entry for ${method} ${API}${path}` };
    }
    const body = object(req.body);
    if (!body) return { unpriced: 'Exa requests need a JSON object body' };
    // Streamed responses are server-sent events: no cost to read, so they settle at worst case.
    const stream = body.stream === true ? '.stream' : '';

    if (path === '/answer') return one(`exa.answer${stream}`, 'exa.answer');
    if (subpages(body)) return { unpriced: 'subpages are not priced' };

    if (path === '/contents') {
      const urls = body.urls ?? body.ids;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_CONTENT_URLS) {
        return { unpriced: 'contents needs a urls array' };
      }
      // Text is returned when no content type is named.
      const types = Math.max(contentTypes(body), 1);
      return one('exa.contents', 'exa.contents.page', BigInt(urls.length * types));
    }

    const type = body.type ?? 'auto';
    const sku = typeof type === 'string' ? SEARCH_SKUS[type] : undefined;
    if (!sku) return { unpriced: `search type ${JSON.stringify(type)} is not priced` };
    const n = intIn(body.numResults, 1, MAX_RESULTS, INCLUDED_RESULTS);
    if (n === null) return { unpriced: 'numResults must be 1 to 100' };
    const items: LineItem[] = [{ sku, units: 1n }];
    if (n > INCLUDED_RESULTS) {
      items.push({ sku: 'exa.search.extra_result', units: BigInt(n - INCLUDED_RESULTS) });
    }
    const types = contentTypes(body);
    if (types > 0) items.push({ sku: 'exa.contents.page', units: BigInt(n * types) });
    return { route: `exa.search${stream}`, items };
  }

  billingSession(): null {
    return null;
  }

  needsBody(c: PricedClassified): boolean {
    return !c.route.endsWith('.stream');
  }

  worstCase(c: PricedClassified, ctx: PriceCtx): bigint {
    return priceItems(this.catalog.skus, c.items, ctx);
  }

  /**
   * `costDollars.total` when Exa sent one, rounded up to a micro. A total above the worst case is
   * kept (and flags the catalog as underpriced): it is what Exa bills.
   */
  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint {
    if (!this.billedOnStatus(res.status)) return 0n;
    const total = object(object(res.body)?.costDollars)?.total;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
      return this.worstCase(c, ctx);
    }
    // Dollar amounts with at most a few decimals: scale exactly before rounding up.
    return BigInt(Math.ceil(Number((total * 1e6).toFixed(3))));
  }

  /** Exa takes `x-api-key` or a bearer token; only `x-api-key` is sent. */
  injectCredential(req: OutgoingReq, secret: string): void {
    delete req.headers.authorization;
    req.headers['x-api-key'] = secret;
  }

  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401;
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}
