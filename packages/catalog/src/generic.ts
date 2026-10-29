import { z } from 'zod';
import { normalizedHash } from './hash.js';
import { parseUsd } from './pricing.js';
import type {
  Classified,
  IncomingReq,
  OutgoingReq,
  PricedClassified,
  ProviderAdapter,
  UpstreamRes,
} from './types.js';

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);

export const genericConfigSchema = z.strictObject({
  id,
  prefix: z.string().regex(/^\/[A-Za-z0-9_.-]+$/),
  origin: z.url({ protocol: /^https?$/ }).transform((u) => new URL(u).origin),
  auth: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('header'),
      name: z.string(),
      valuePrefix: z.string().default(''),
    }),
    z.strictObject({ type: z.literal('query'), name: z.string() }),
  ]),
  routes: z
    .array(
      z.strictObject({
        method: z.string().default('*'),
        /** Path glob: `*` matches one segment, `**` any number of segments. */
        path: z.string().startsWith('/'),
        sku: id,
        /** USD per request, e.g. "0.005". */
        pricePerRequest: z.string().regex(/^\d+(\.\d{1,6})?$/),
      }),
    )
    .min(1),
  /** Status codes the provider bills: only 2xx by default. */
  billed: z.enum(['2xx', 'all']).default('2xx'),
  timeoutBilled: z.boolean().default(true),
});

export type GenericConfig = z.input<typeof genericConfigSchema>;

function globToRegExp(glob: string): RegExp {
  const parts = glob.split('/').map((seg) => {
    if (seg === '**') return '.*';
    return seg
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

/** Any unlisted API: user-defined route match and a flat price per request. */
export class GenericAdapter implements ProviderAdapter {
  readonly id: string;
  readonly upstreams;
  readonly timeoutBilled: boolean;
  private readonly cfg: z.output<typeof genericConfigSchema>;
  private readonly routes: { method: string; re: RegExp; sku: string; micros: bigint }[];

  constructor(config: GenericConfig) {
    this.cfg = genericConfigSchema.parse(config);
    this.id = this.cfg.id;
    this.upstreams = [{ prefix: this.cfg.prefix, origin: this.cfg.origin }] as const;
    this.timeoutBilled = this.cfg.timeoutBilled;
    this.routes = this.cfg.routes.map((r) => ({
      method: r.method.toUpperCase(),
      re: globToRegExp(r.path),
      sku: r.sku,
      micros: parseUsd(r.pricePerRequest),
    }));
  }

  match(req: IncomingReq): boolean {
    return req.origin === this.cfg.origin;
  }

  classify(req: IncomingReq): Classified {
    const hash = normalizedHash({
      method: req.method,
      origin: req.origin,
      path: req.path,
      query: req.query,
      body: req.body,
      volatile: this.cfg.auth.type === 'query' ? [this.cfg.auth.name] : [],
    });
    const method = req.method.toUpperCase();
    const route = this.routes.find(
      (r) => (r.method === '*' || r.method === method) && r.re.test(req.path),
    );
    if (!route) {
      return {
        priced: false,
        provider: this.id,
        reason: `no route for ${method} ${req.path}`,
        normalizedHash: hash,
      };
    }
    return {
      priced: true,
      provider: this.id,
      route: route.sku,
      items: [{ sku: route.sku, units: 1n }],
      normalizedHash: hash,
    };
  }

  worstCase(c: PricedClassified): bigint {
    return c.items.reduce((sum, item) => {
      const route = this.routes.find((r) => r.sku === item.sku);
      if (!route) throw new Error(`unknown sku ${item.sku}`);
      return sum + route.micros * item.units;
    }, 0n);
  }

  actual(c: PricedClassified, res: UpstreamRes): bigint {
    return this.billedOnStatus(res.status) ? this.worstCase(c) : 0n;
  }

  injectCredential(req: OutgoingReq, secret: string): void {
    const auth = this.cfg.auth;
    if (auth.type === 'query') {
      req.query.set(auth.name, secret);
    } else {
      req.headers[auth.name.toLowerCase()] = `${auth.valuePrefix}${secret}`;
    }
  }

  billedOnStatus(status: number): boolean {
    return this.cfg.billed === 'all' || (status >= 200 && status < 300);
  }
}
