import { z } from 'zod';
import { normalizedHash } from './hash.js';
import { MICROS_PER_USD, parseUsd } from './pricing.js';
import type {
  Classified,
  IncomingReq,
  OutgoingReq,
  PricedClassified,
  ProviderAdapter,
  UpstreamRes,
} from './types.js';

// One adapter for every API without a built-in one: the operator's BRAKE_GENERIC_PROVIDERS
// (global, from the proxy's environment) and each org's own custom APIs (stored by the admin
// API, read by the proxy from Valkey). Both use the same route and pricing definitions.

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
/** USD as a decimal string, up to 6 decimals (micro-dollars). */
const usd = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, 'Expected USD such as "0.005".');
/** USD per reported unit: finer than a micro-dollar is allowed (1 credit = $0.0000005). */
const usdPerUnit = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,12})?$/, 'Expected USD per unit such as "0.001".');
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const JSON_PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,15}$/;

/** Proxy path under which org custom APIs are served: `<proxy>/custom/<id>/...`. */
export const CUSTOM_PREFIX = '/custom';

// Headers a custom API's credential may not be put in: the proxy and HTTP own them.
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'cookie',
]);

// The definitions are built twice: strict (operator config and the admin API reject unknown
// fields, so a typo is an error) and stripping (records the proxy reads from Valkey, which a newer
// API may have written with fields this build does not know).
type ObjectFn = typeof z.object;

function definitions(object: ObjectFn) {
  const perRequest = object({ model: z.literal('perRequest'), usd });
  const reported = object({
    model: z.literal('reported'),
    /** Response header holding the cost, e.g. `x-credits-used`. */
    header: z.string().regex(HEADER_NAME).optional(),
    /** Dot path in a top-level JSON response body, e.g. `usage.cost`. */
    jsonPath: z.string().regex(JSON_PATH, 'Expected a dot path such as usage.cost.').optional(),
    /** USD per reported unit ("1" when the API reports dollars). */
    usdPerUnit,
    /** Reserved before each call (the worst case), and charged when no cost is reported. */
    maxPerRequest: usd,
  }).refine((p) => (p.header === undefined) !== (p.jsonPath === undefined), {
    message: 'Give either header or jsonPath.',
  });
  const pricing = z.discriminatedUnion('model', [perRequest, reported]);

  const route = object({
    method: z
      .string()
      .regex(/^(\*|[A-Za-z]{1,16})$/)
      .default('*'),
    /** Path glob: `*` matches one segment, `**` any number of segments. */
    path: z.string().startsWith('/').max(512),
    sku: id,
    pricing: pricing.optional(),
    /** Older spelling of `pricing: { model: 'perRequest', usd }`, still accepted. */
    pricePerRequest: usd.optional(),
  })
    .refine((r) => (r.pricing === undefined) !== (r.pricePerRequest === undefined), {
      message: 'Give pricing (or pricePerRequest).',
    })
    .transform(({ pricePerRequest, pricing, ...r }) => ({
      ...r,
      pricing: pricing ?? { model: 'perRequest' as const, usd: pricePerRequest! },
    }));

  const auth = z.discriminatedUnion('type', [
    object({
      type: z.literal('header'),
      name: z.string().regex(HEADER_NAME),
      valuePrefix: z.string().max(64).default(''),
    }),
    object({ type: z.literal('query'), name: z.string().min(1).max(128) }),
  ]);

  return {
    auth,
    route,
    fields: {
      id,
      auth,
      routes: z.array(route).min(1),
      /** Status codes the provider bills: only 2xx by default. */
      billed: z.enum(['2xx', 'all']).default('2xx'),
      timeoutBilled: z.boolean().default(true),
    },
  };
}

const strict = definitions(z.strictObject as unknown as ObjectFn);
const lenient = definitions(z.object);

export const genericConfigSchema = z
  .strictObject({
    ...strict.fields,
    prefix: z
      .string()
      .regex(/^\/[A-Za-z0-9_.-]+$/)
      .refine((p) => p !== CUSTOM_PREFIX, `${CUSTOM_PREFIX} is reserved for org custom APIs.`),
    origin: z.url({ protocol: /^https?$/ }).transform((u) => new URL(u).origin),
  })
  .refine((c) => c.auth.type !== 'header' || !RESERVED_HEADERS.has(c.auth.name.toLowerCase()), {
    message: 'That header cannot carry the credential.',
    path: ['auth', 'name'],
  });

export type GenericConfig = z.input<typeof genericConfigSchema>;

/**
 * A custom API's origin: https, no user name or password, nothing after the host and port (paths
 * belong in the routes). Where it may point (private addresses, the service's own domains) is
 * checked by the admin API when it is saved, and by the proxy's guarded agent when it connects.
 */
export const customApiOrigin = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Expected a URL such as https://api.example.com.' });
      return;
    }
    if (u.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'Use https.' });
    if (u.username || u.password) {
      ctx.addIssue({
        code: 'custom',
        message: 'No credentials in the URL: store the key as a provider key.',
      });
    }
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only the origin (https://host[:port]); put paths in the routes.',
      });
    }
  })
  .transform((value) => new URL(value).origin);

function customFields(d: ReturnType<typeof definitions>) {
  const { auth, billed, timeoutBilled } = d.fields;
  return {
    auth,
    billed,
    timeoutBilled,
    name: z.string().min(1).max(200),
    origin: customApiOrigin,
    routes: d.fields.routes.max(100),
  };
}

type CustomShape = {
  auth: { type: string; name: string };
  routes: { sku: string; pricing: unknown }[];
};

function customRules<T extends z.ZodType<CustomShape>>(schema: T): T {
  return schema
    .refine((c) => c.auth.type !== 'header' || !RESERVED_HEADERS.has(c.auth.name.toLowerCase()), {
      message: 'That header cannot carry the credential.',
      path: ['auth', 'name'],
    })
    .refine(
      // The SKU names the price: two routes with one SKU must price it the same way.
      (c) =>
        c.routes.every((r) =>
          c.routes.every(
            (o) => o.sku !== r.sku || JSON.stringify(o.pricing) === JSON.stringify(r.pricing),
          ),
        ),
      { message: 'Routes that share a SKU must have the same pricing.', path: ['routes'] },
    );
}

/** An org's custom API as the admin API accepts it (unknown fields are refused). */
export const customApiSchema = customRules(z.strictObject({ id, ...customFields(strict) }));
/** The same without the id (the id names it and never changes). */
export const customApiUpdateSchema = customRules(z.strictObject(customFields(strict)));
/** An org's custom API as the proxy reads it from Valkey (unknown fields are dropped). */
export const customApiRecordSchema = customRules(z.object({ id, ...customFields(lenient) }));

export type CustomApiInput = z.input<typeof customApiSchema>;
export type CustomApi = z.output<typeof customApiSchema>;
export type RoutePricing = z.output<typeof strict.route>['pricing'];

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

/** Largest amount the budget engine accepts (2^53 - 1 micros). */
const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const PICO = 1_000_000_000_000n;

/** A decimal string or number as an integer number of 10^-12 units, rounded up; null if invalid. */
function toPico(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 1e15) return null;
    text = value.toFixed(12);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  const kept = BigInt(frac.slice(0, 12).padEnd(12, '0'));
  const roundUp = /[1-9]/.test(frac.slice(12)) ? 1n : 0n;
  return BigInt(m[1]!) * PICO + kept + roundUp;
}

type Price =
  | { model: 'perRequest'; micros: bigint }
  | {
      model: 'reported';
      header: string | null;
      jsonPath: string[] | null;
      /** USD per unit in 10^-12 dollars. */
      picoPerUnit: bigint;
      maxMicros: bigint;
    };

interface CompiledRoute {
  method: string;
  re: RegExp;
  sku: string;
  price: Price;
}

type Definition = z.output<typeof genericConfigSchema>;

function compile(r: Definition['routes'][number]): CompiledRoute {
  const p = r.pricing;
  return {
    method: r.method.toUpperCase(),
    re: globToRegExp(r.path),
    sku: r.sku,
    price:
      p.model === 'perRequest'
        ? { model: 'perRequest', micros: parseUsd(p.usd) }
        : {
            model: 'reported',
            header: p.header?.toLowerCase() ?? null,
            jsonPath: p.jsonPath?.split('.') ?? null,
            picoPerUnit: toPico(p.usdPerUnit)!,
            maxMicros: parseUsd(p.maxPerRequest),
          },
  };
}

/** Why a reported cost was not simply charged: none could be read, or it was above the max. */
export type CostNote = 'cost_unreported' | 'over_max';

/**
 * Any unlisted API: user-defined route match, priced either at a flat price per request or at the
 * cost the API reports in its response (a header or a JSON field), with a maximum reserved up
 * front.
 */
export class GenericAdapter implements ProviderAdapter {
  readonly id: string;
  readonly upstreams;
  readonly timeoutBilled: boolean;
  private readonly origin: string;
  private readonly auth: Definition['auth'];
  private readonly billed: Definition['billed'];
  private readonly routes: CompiledRoute[];

  /** An org's custom API from its stored record, served at `/custom/<id>`. */
  static fromCustomApi(record: unknown): GenericAdapter {
    const c = customApiRecordSchema.parse(record);
    return new GenericAdapter({ ...c, prefix: `${CUSTOM_PREFIX}/${c.id}` }, true);
  }

  constructor(config: GenericConfig);
  constructor(config: Definition, parsed: true);
  constructor(config: GenericConfig | Definition, parsed = false) {
    const cfg = parsed ? (config as Definition) : genericConfigSchema.parse(config);
    this.id = cfg.id;
    this.origin = cfg.origin;
    this.auth = cfg.auth;
    this.billed = cfg.billed;
    this.upstreams = [{ prefix: cfg.prefix, origin: cfg.origin }] as const;
    this.timeoutBilled = cfg.timeoutBilled;
    this.routes = cfg.routes.map(compile);
  }

  match(req: IncomingReq): boolean {
    return req.origin === this.origin;
  }

  classify(req: IncomingReq): Classified {
    const hash = normalizedHash({
      method: req.method,
      origin: req.origin,
      path: req.path,
      query: req.query,
      body: req.body,
      volatile: this.auth.type === 'query' ? [this.auth.name] : [],
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

  billingSession(): null {
    return null;
  }

  private routeOf(sku: string): CompiledRoute {
    const route = this.routes.find((r) => r.sku === sku);
    if (!route) throw new Error(`unknown sku ${sku}`);
    return route;
  }

  needsBody(c: PricedClassified): boolean {
    return c.items.some((i) => {
      const p = this.routeOf(i.sku).price;
      return p.model === 'reported' && p.jsonPath !== null;
    });
  }

  credentialRejected(res: UpstreamRes): boolean {
    return res.status === 401 || res.status === 403;
  }

  worstCase(c: PricedClassified): bigint {
    return c.items.reduce((sum, item) => {
      const p = this.routeOf(item.sku).price;
      return sum + (p.model === 'perRequest' ? p.micros : p.maxMicros) * item.units;
    }, 0n);
  }

  /** The cost the API reported for one request in micros (rounded up), or null when unreadable. */
  reportedCost(c: PricedClassified, res: UpstreamRes): bigint | null {
    const p = this.routeOf(c.items[0]!.sku).price;
    if (p.model !== 'reported') return null;
    let value: unknown;
    if (p.header !== null) {
      value = res.headers[p.header];
    } else if (p.jsonPath !== null) {
      // Only a JSON answer the proxy buffered (within its limit) is read.
      if (!/[/+]json\b/i.test(res.headers['content-type'] ?? '')) return null;
      value = res.body;
      for (const key of p.jsonPath) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        if (!Object.hasOwn(value, key)) return null;
        value = (value as Record<string, unknown>)[key];
      }
    }
    const pico = toPico(value);
    if (pico === null) return null;
    // pico * picoPerUnit is in 10^-24 USD; one micro-dollar is 10^18 of those.
    const scale = (PICO * PICO) / MICROS_PER_USD;
    const micros = (pico * p.picoPerUnit + scale - 1n) / scale;
    return micros > MAX_MICROS ? MAX_MICROS : micros;
  }

  /**
   * Reported pricing settles at the cost the API reports, even above `maxPerRequest` (it was
   * spent); with no readable cost it settles at `maxPerRequest`.
   */
  actual(c: PricedClassified, res: UpstreamRes): bigint {
    if (!this.billedOnStatus(res.status)) return 0n;
    const p = this.routeOf(c.items[0]!.sku).price;
    if (p.model === 'perRequest') return this.worstCase(c);
    return this.reportedCost(c, res) ?? p.maxMicros;
  }

  costNote(c: PricedClassified, res: UpstreamRes): CostNote | null {
    if (!this.billedOnStatus(res.status)) return null;
    const p = this.routeOf(c.items[0]!.sku).price;
    if (p.model !== 'reported') return null;
    const reported = this.reportedCost(c, res);
    if (reported === null) return 'cost_unreported';
    return reported > p.maxMicros ? 'over_max' : null;
  }

  injectCredential(req: OutgoingReq, secret: string): void {
    const auth = this.auth;
    if (auth.type === 'query') {
      req.query.set(auth.name, secret);
    } else {
      req.headers[auth.name.toLowerCase()] = `${auth.valuePrefix}${secret}`;
    }
  }

  billedOnStatus(status: number): boolean {
    return this.billed === 'all' || (status >= 200 && status < 300);
  }
}
