/** A request as the proxy sees it, after the route prefix picked an upstream. */
export interface IncomingReq {
  method: string;
  /** Upstream origin, e.g. `https://places.googleapis.com`. */
  origin: string;
  /** Path on the upstream, starting with `/`. */
  path: string;
  query: URLSearchParams;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, when there is one. */
  body?: unknown;
}

export interface UpstreamRes {
  status: number;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, when the proxy kept a copy. Adapters fall back to the worst case without it. */
  body?: unknown;
}

export interface OutgoingReq {
  origin: string;
  headers: Record<string, string | undefined>;
  query: URLSearchParams;
}

export interface LineItem {
  sku: string;
  units: bigint;
}

export type Classified =
  | {
      priced: true;
      provider: string;
      /** Stable name for the endpoint, e.g. `places.text_search`. */
      route: string;
      /** One request can bill several SKUs (legacy Places data SKUs). */
      items: LineItem[];
      normalizedHash: string;
    }
  | {
      priced: false;
      provider: string;
      reason: string;
      normalizedHash: string;
    };

export type PricedClassified = Extract<Classified, { priced: true }>;

export interface PriceCtx {
  /** Units of each SKU the proxy already counted this month (selects the volume tier). */
  monthlyUnits: ReadonlyMap<string, bigint>;
  /** Price units inside the monthly free allowance at zero. Only safe when the proxy is the key's sole caller. */
  trustFreeTier: boolean;
}

export interface Upstream {
  /** Route prefix on the proxy, e.g. `/google-maps`. */
  prefix: string;
  origin: string;
}

export interface ProviderAdapter {
  id: string;
  /** The only origins the proxy may forward to for this provider (SSRF allow-list). */
  upstreams: readonly Upstream[];
  match(req: IncomingReq): boolean;
  classify(req: IncomingReq): Classified;
  worstCase(c: PricedClassified, ctx: PriceCtx): bigint;
  actual(c: PricedClassified, res: UpstreamRes, ctx: PriceCtx): bigint;
  injectCredential(req: OutgoingReq, secret: string): void;
  /** Whether the provider bills a response with this status (some routes bill redirects). */
  billedOnStatus(status: number, c?: PricedClassified): boolean;
  /** Whether the provider may have billed a request that timed out. */
  timeoutBilled: boolean;
}
