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
import { type Route, classified, object, one } from './common.js';

export const BRAVE = 'brave';
const API = 'https://api.search.brave.com';
export const BRAVE_UPSTREAMS = [{ prefix: '/brave', origin: API }] as const;

const SEARCH = new Set([
  '/res/v1/web/search',
  '/res/v1/news/search',
  '/res/v1/videos/search',
  '/res/v1/images/search',
]);
const SUGGEST = new Set(['/res/v1/suggest/search', '/res/v1/spellcheck/search']);

export function loadBraveCatalog(): Catalog {
  return parseCatalog(readDataFile('brave/catalog.yaml'));
}

/**
 * Brave Search API: web, news, video, image and LLM-context search on the Search plan, plus
 * autosuggest and spellcheck, each a flat price per request. Answers (token-priced), local POI
 * lookups and the summarizer are not priced, so they are denied.
 */
export class BraveAdapter implements ProviderAdapter {
  readonly id = BRAVE;
  readonly upstreams = BRAVE_UPSTREAMS;
  readonly timeoutBilled = true;
  readonly catalog: Catalog;

  constructor(opts: { catalog?: Catalog } = {}) {
    this.catalog = opts.catalog ?? loadBraveCatalog();
  }

  match(req: IncomingReq): boolean {
    return req.origin === API;
  }

  classify(req: IncomingReq): Classified {
    return classified(BRAVE, this.catalog, this.route(req), normalizedHash(req));
  }

  private route(req: IncomingReq): Route {
    const { method, path } = req;
    if (method === 'GET' && SEARCH.has(path)) return one(`brave${route(path)}`, 'brave.search');
    if ((method === 'GET' || method === 'POST') && path === '/res/v1/llm/context') {
      return one('brave.llm_context', 'brave.search');
    }
    if (method === 'GET' && SUGGEST.has(path)) return one(`brave${route(path)}`, 'brave.suggest');
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
    req.headers['x-subscription-token'] = secret;
  }

  /** Brave answers a bad token with 401, or 422 and code SUBSCRIPTION_TOKEN_INVALID. */
  credentialRejected(res: UpstreamRes): boolean {
    if (res.status === 401 || res.status === 403) return true;
    const code = object(object(res.body)?.error)?.code;
    return res.status === 422 && code === 'SUBSCRIPTION_TOKEN_INVALID';
  }

  billedOnStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}

/** `/res/v1/web/search` -> `.web`. */
function route(path: string): string {
  return `.${path.split('/')[3]}`;
}
