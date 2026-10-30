import { createHash, randomUUID } from 'node:crypto';
import {
  BudgetEngine,
  type CapTemplate,
  type Crossing,
  DEFAULT_LOOP_POLICY,
  DEFAULT_PUMPING_POLICY,
  type KeyRecord,
  type KillTarget,
  type OrgRecord,
  Registry,
  type ReservationHandle,
  type Scope,
  type ValkeyClient,
  isVirtualKey,
  scopeLabel,
  windowsFor,
} from '@spend-brake/budget';
import type {
  IncomingReq,
  LineItem,
  PriceCtx,
  PricedClassified,
  ProviderAdapter,
  Upstream,
} from '@spend-brake/catalog';
import { redactUrl, redactingLoggerOptions } from '@spend-brake/shared';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { type Dispatcher, request as undiciRequest } from 'undici';
import { TtlCache } from './cache.js';
import { outcomes, sendError } from './errors.js';
import { ProxyMetrics } from './metrics.js';
import {
  decodeBody,
  outgoingHeaders,
  parseBody,
  parseJson,
  responseHeaders,
  upstreamUrl,
} from './forward.js';
import { LocalBudget } from './local-budget.js';
import type { SecretStore } from './secrets.js';

export interface ProxyDeps {
  valkey: ValkeyClient;
  adapters: ProviderAdapter[];
  secrets: SecretStore;
  /** Test/dev only: origin -> base URL to send that provider's traffic to instead. */
  upstreamOverrides?: Record<string, string>;
  upstreamTimeoutMs?: number;
  dispatcher?: Dispatcher;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
  /** Key and org config cache TTL (doc: 5 s). */
  configTtlMs?: number;
  /** Largest response body buffered for pricing. */
  maxBufferedBytes?: number;
  now?: () => Date;
  metrics?: ProxyMetrics;
  /** How often fail-open spend is retried into Valkey. */
  replayIntervalMs?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Wait for background settlement (commit, units, events) to finish. */
    brakeDrain(): Promise<void>;
    /** Record fail-open spend in Valkey now; returns how many entries were written. */
    brakeReplayFailOpen(): Promise<number>;
    brakeMetrics: ProxyMetrics;
    /** Swap in adapters built from reloaded catalogs (same prefixes and upstreams). */
    brakeSetAdapters(adapters: ProviderAdapter[]): void;
  }
}

class KeyNotFound extends Error {}

const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;
/** Messaging destinations allowed when a key has no country list: high-risk ones need opting in. */
const DEFAULT_COUNTRIES = ['US', 'CA'];
const CONFIG_STALE_MS = 10 * 60_000;
const DEFAULT_SKU = 'unpriced';
// Where a provider's own key goes, so a virtual key can take its place: Google `key`, Mapbox
// `access_token`, HERE `apiKey`.
const DROP_IN_PARAMS = ['key', 'access_token', 'apiKey', 'api_key'];
const DROP_IN_HEADERS = ['x-goog-api-key', 'x-api-key', 'x-subscription-token'];

interface Route {
  adapter: ProviderAdapter;
  upstream: Upstream;
}

interface Auth {
  key: KeyRecord;
  org: OrgRecord;
  /** Config came from the stale cache because Valkey is unreachable. */
  stale: boolean;
}

interface Priced {
  classified: PricedClassified | null;
  items: LineItem[];
  worst: bigint;
  hash: string;
  route: string;
}

/**
 * Whether a request path has a `.` or `..` segment or a backslash (also percent-encoded): the
 * upstream URL would resolve it to a different path than the adapter priced.
 */
export function unsafePath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  if (pathname.includes('\\')) return true;
  return pathname.split('/').some((seg) => {
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return true;
    }
    return s === '.' || s === '..' || s.includes('\\');
  });
}

const micros = (v: bigint | null) => (v === null ? null : Number(v));

function compact(event: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(event).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

export function buildServer(deps: ProxyDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const engine = new BudgetEngine(deps.valkey);
  const registry = new Registry(deps.valkey);
  const configTtl = deps.configTtlMs ?? 5_000;
  const keyCache = new TtlCache<KeyRecord>(configTtl, CONFIG_STALE_MS);
  // Unknown tokens live in their own small cache so a flood of them cannot evict the real keys
  // that fail-open depends on during an outage.
  const missCache = new TtlCache<true>(configTtl, 0, 1_000);
  const metrics = deps.metrics ?? new ProxyMetrics();
  const labels = new WeakMap<FastifyRequest, { provider: string; sku: string }>();
  const orgCache = new TtlCache<OrgRecord | null>(configTtl, CONFIG_STALE_MS);
  // Unit counts only grow, so a stale count can only select a pricier volume band.
  const unitsCache = new TtlCache<bigint>(configTtl, 0);
  const local = new LocalBudget();
  const pending = new Set<Promise<unknown>>();
  const timeout = deps.upstreamTimeoutMs ?? 30_000;
  const maxBuffered = deps.maxBufferedBytes ?? 32 * 1024 * 1024;

  const routesOf = (adapters: ProviderAdapter[]): Route[] =>
    adapters.flatMap((adapter) => adapter.upstreams.map((upstream) => ({ adapter, upstream })));
  // Replaced as a whole when catalogs are reloaded; a request keeps the route it matched.
  let routes = routesOf(deps.adapters);

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  // Keep request bodies as raw bytes: they are forwarded unchanged and parsed only to classify.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-brake-request-id', request.id);
    done(null, payload);
  });

  app.addHook('onResponse', (request, _reply, done) => {
    if (request.url !== '/healthz') {
      const l = labels.get(request) ?? { provider: '', sku: '' };
      metrics.requests.inc({ ...l, outcome: outcomes.get(request) ?? 'ok' });
    }
    done();
  });

  // Fail-open spend is recorded once Valkey answers again, so the ledger, alerts and the next
  // windows see it.
  async function replayFailOpen(): Promise<number> {
    let n = 0;
    while (local.journal.length > 0) {
      const e = local.journal[0]!;
      try {
        await engine.recordSpend({
          orgId: e.orgId,
          amount: e.amount,
          scopes: e.scopes,
          timeZone: e.timeZone,
          at: e.at,
          units: e.units,
          event: e.event,
        });
      } catch {
        break;
      }
      local.journal.shift();
      metrics.failOpenReplayed.inc();
      n++;
    }
    return n;
  }
  const replayTimer = setInterval(() => {
    if (local.journal.length > 0) track(replayFailOpen());
  }, deps.replayIntervalMs ?? 5_000);
  replayTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(replayTimer);
    await Promise.allSettled([...pending]);
  });

  app.decorate('brakeReplayFailOpen', replayFailOpen);
  app.decorate('brakeMetrics', metrics);
  app.decorate('brakeSetAdapters', (adapters: ProviderAdapter[]) => {
    routes = routesOf(adapters);
  });

  app.decorate('brakeDrain', async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  });

  app.setErrorHandler((err, request, reply) => {
    const e = err as { message?: string; code?: string; statusCode?: number };
    request.log.error(
      { err: { message: redactUrl(e.message ?? ''), code: e.code } },
      'proxy error',
    );
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(reply, 'invalid_request', 'Request body too large.');
    }
    return sendError(reply, 'internal_error', 'Internal proxy error.');
  });

  app.get('/healthz', () => ({ ok: true, service: 'proxy' }));

  function track(p: Promise<unknown>): void {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  function emit(orgId: string, event: Record<string, string | undefined>): void {
    track(engine.emit(orgId, compact(event)).catch(() => undefined));
  }

  function findRoute(url: string): { route: Route; path: string; query: URLSearchParams } | null {
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    for (const route of routes) {
      const prefix = route.upstream.prefix;
      if (pathname.startsWith(`${prefix}/`)) {
        return {
          route,
          path: pathname.slice(prefix.length),
          query: new URLSearchParams(q === -1 ? '' : url.slice(q + 1)),
        };
      }
    }
    return null;
  }

  function virtualKeyFrom(request: FastifyRequest, query: URLSearchParams): string | null {
    const header = request.headers['x-brake-key'];
    if (typeof header === 'string' && header) return header;
    // Drop-in mode: the virtual key sits where the provider's own key would.
    for (const name of DROP_IN_PARAMS) {
      const param = query.get(name);
      if (param && isVirtualKey(param)) return param;
    }
    // HERE OAuth and Tavily clients send their key as a bearer token.
    const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (bearer && isVirtualKey(bearer)) return bearer;
    // Provider SDKs that send their key in a header of their own (Google, Exa, Brave).
    for (const name of DROP_IN_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string' && isVirtualKey(value)) return value;
    }
    return null;
  }

  async function authenticate(token: string): Promise<Auth | null> {
    if (missCache.peek(token)) return null;
    let k: { value: KeyRecord; stale: boolean };
    try {
      k = await keyCache.get(
        token,
        async () => {
          const found = await registry.getKeyByToken(token);
          if (!found) throw new KeyNotFound();
          return found;
        },
        (err) => !(err instanceof KeyNotFound),
      );
    } catch (err) {
      if (!(err instanceof KeyNotFound)) throw err;
      keyCache.delete(token);
      missCache.set(token, true);
      return null;
    }
    const key = k.value;
    const o = await orgCache.get(key.orgId, () => registry.getOrg(key.orgId));
    const org = o.value ?? {
      id: key.orgId,
      timeZone: 'UTC',
      providers: {},
      loop: DEFAULT_LOOP_POLICY,
    };
    return { key, org, stale: k.stale || o.stale };
  }

  async function monthlyUnits(
    org: OrgRecord,
    skus: string[],
    at: Date,
  ): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    const month = windowsFor(at, org.timeZone)[1].id;
    await Promise.all(
      skus.map(async (sku) => {
        const { value } = await unitsCache.get(`${org.id}|${sku}|${month}`, async () => {
          const m = await engine.monthlyUnits(org.id, [sku], org.timeZone, at);
          return m.get(sku) ?? 0n;
        });
        result.set(sku, value);
      }),
    );
    return result;
  }

  app.all('/*', async (request, reply) => {
    const started = performance.now();
    const at = now();
    // The upstream URL resolves `.`/`..` segments (WHATWG URL), so a path the adapter priced as
    // one endpoint could reach another. Such paths never come from a real client.
    if (unsafePath(request.url)) {
      return sendError(
        reply,
        'invalid_request',
        'Path must not contain dot segments or backslashes.',
      );
    }
    const found = findRoute(request.url);
    if (!found)
      return sendError(reply, 'unknown_route', 'No provider is configured for this path.');
    const { route, path, query } = found;
    const { adapter, upstream } = route;
    labels.set(request, { provider: adapter.id, sku: '' });

    // 1. Authenticate.
    const token = virtualKeyFrom(request, query);
    if (!token) return sendError(reply, 'invalid_key', 'Missing virtual key (X-Brake-Key).');
    let auth: Auth | null;
    try {
      auth = await authenticate(token);
    } catch {
      return sendError(reply, 'budget_unavailable', 'Budget store unavailable; request blocked.');
    }
    const key = auth?.key;
    if (!auth || !key || key.status !== 'active') {
      return sendError(reply, 'invalid_key', 'Unknown or revoked virtual key.');
    }
    if (key.expiresAt && Date.parse(key.expiresAt) <= at.getTime()) {
      return sendError(reply, 'invalid_key', 'Virtual key has expired.');
    }
    if (key.allowedIps && !key.allowedIps.includes(request.ip)) {
      return sendError(reply, 'invalid_key', 'Virtual key is not allowed from this address.');
    }
    const credentialId = key.credentials[adapter.id];
    if (!credentialId) {
      return sendError(reply, 'sku_not_allowed', `Key may not call provider ${adapter.id}.`);
    }
    const { org } = auth;
    // A session key carries its session; otherwise the client may name one.
    const session = key.sessionId ?? request.headers['x-brake-session'];
    if (session !== undefined && (typeof session !== 'string' || !SESSION_ID.test(session))) {
      return sendError(reply, 'invalid_request', 'Invalid X-Brake-Session.');
    }
    // Sessions are client-named scopes; only keys with a session budget may open them, so a
    // client cannot create unbounded per-session counters.
    if (session !== undefined && key.sessionCapMicros === null && key.sessionId === null) {
      return sendError(
        reply,
        'invalid_request',
        'This key has no session budget; drop X-Brake-Session.',
      );
    }
    query.delete('key');
    for (const name of DROP_IN_PARAMS) if (isVirtualKey(query.get(name) ?? '')) query.delete(name);

    // 2. Classify and price.
    const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;
    const incoming: IncomingReq = {
      method: request.method,
      origin: upstream.origin,
      path,
      query,
      headers: request.headers as Record<string, string | undefined>,
      body: parseBody(rawBody, request.headers['content-type']),
    };
    const providerCfg = org.providers[adapter.id] ?? {
      trustFreeTier: false,
      unpricedPolicy: 'deny' as const,
    };
    const billingSession = adapter.billingSession(incoming);
    const billingSessionHash = billingSession
      ? createHash('sha256').update(billingSession.token).digest('hex').slice(0, 32)
      : null;
    let priced: Priced;
    // The worst case never applies the free allowance: concurrent or cached counts could put
    // more requests inside it than it holds. Only the actual cost uses it (fresh counts below).
    let ctx: PriceCtx = { monthlyUnits: new Map(), trustFreeTier: false };
    try {
      const calls =
        billingSessionHash === null
          ? 0
          : await engine.billingSessionCalls(org.id, adapter.id, billingSessionHash);
      const c = adapter.classify(incoming, {
        billingSessionStarted: calls > 0,
        billingSessionCalls: calls,
      });
      if (c.priced) {
        ctx = {
          monthlyUnits: await monthlyUnits(org, [...new Set(c.items.map((i) => i.sku))], at),
          trustFreeTier: false,
        };
        priced = {
          classified: c,
          items: c.items,
          worst: adapter.worstCase(c, ctx),
          hash: c.normalizedHash,
          route: c.route,
        };
      } else if (
        providerCfg.unpricedPolicy === 'allow-with-default-price' &&
        providerCfg.defaultPriceMicros !== undefined
      ) {
        priced = {
          classified: null,
          items: [{ sku: DEFAULT_SKU, units: 1n }],
          worst: BigInt(providerCfg.defaultPriceMicros),
          hash: c.normalizedHash,
          route: DEFAULT_SKU,
        };
      } else {
        emit(org.id, {
          type: 'blocked',
          reason: 'unpriced_route',
          reqId: request.id,
          keyId: key.id,
          provider: adapter.id,
        });
        return sendError(reply, 'unpriced_route', 'No price for this route; request blocked.', {
          detail: c.reason,
        });
      }
    } catch (err) {
      if (!auth.stale && !key.failOpenMicros) {
        request.log.warn({ err: (err as Error).message }, 'pricing lookup failed');
        return sendError(reply, 'budget_unavailable', 'Budget store unavailable; request blocked.');
      }
      // Valkey is down and the key may fail open: price without unit counts (top band).
      const c = adapter.classify(incoming);
      if (!c.priced) return sendError(reply, 'unpriced_route', 'No price for this route.');
      priced = {
        classified: c,
        items: c.items,
        worst: adapter.worstCase(c, ctx),
        hash: c.normalizedHash,
        route: c.route,
      };
    }
    labels.set(request, { provider: adapter.id, sku: priced.items[0]?.sku ?? '' });
    if (key.skus && !priced.items.every((i) => key.skus!.includes(i.sku))) {
      return sendError(reply, 'sku_not_allowed', 'Key may not call this SKU.', {
        skus: priced.items.map((i) => i.sku),
      });
    }

    // Messaging: destination country allow-list and the pumping guard, before any money moves.
    const dest = priced.classified?.destination;
    if (dest) {
      const allowed = key.countries ?? DEFAULT_COUNTRIES;
      if (!dest.country || !allowed.includes(dest.country)) {
        emit(org.id, {
          type: 'blocked',
          reason: 'country_not_allowed',
          reqId: request.id,
          keyId: key.id,
          provider: adapter.id,
          country: dest.country ?? 'unknown',
        });
        return sendError(
          reply,
          'sku_not_allowed',
          `This key may not send to ${dest.country ?? 'that number'}; allowed: ${allowed.join(', ')}.`,
          { country: dest.country },
        );
      }
      try {
        const pump = await engine.pumpCheck(
          org.id,
          key.id,
          {
            numberHash: createHash('sha256').update(dest.number).digest('hex').slice(0, 32),
            prefix: dest.prefix.replace(/\D/g, ''),
          },
          key.pumping ?? DEFAULT_PUMPING_POLICY,
        );
        if (!pump.ok) {
          emit(org.id, {
            type: pump.tripped ? 'loop' : 'blocked',
            reason: 'pumping',
            reqId: request.id,
            keyId: key.id,
            provider: adapter.id,
            prefix: dest.prefix,
          });
          reply.header('retry-after', String(pump.retryAfterSec));
          return sendError(
            reply,
            'loop_detected',
            'Too many messages to one number or number range; this key is paused. Stop and ask the user.',
            { retryAfter: pump.retryAfterSec, reason: 'pumping' },
          );
        }
      } catch {
        if (!key.failOpenMicros) {
          return sendError(
            reply,
            'budget_unavailable',
            'Budget store unavailable; request blocked.',
          );
        }
      }
    }

    // 3-4. Loop check and reserve, in one atomic script.
    const sessionScope: Scope | null = session ? { kind: 'sess', id: session } : null;
    const scopes: Scope[] = [
      { kind: 'org' },
      { kind: 'key', id: key.id },
      // Multi-SKU requests count against their primary SKU's scope.
      { kind: 'sku', provider: adapter.id, sku: priced.items[0]!.sku },
    ];
    // Session keys spend from their parent's budget too, and die with it.
    if (key.parentKeyId) scopes.push({ kind: 'key', id: key.parentKeyId });
    if (key.env) scopes.push({ kind: 'env', name: key.env });
    if (key.agentId) scopes.push({ kind: 'agent', id: key.agentId });
    if (sessionScope) scopes.push(sessionScope);
    const killTargets: KillTarget[] = [
      { kind: 'org' },
      { kind: 'key', id: key.id },
      { kind: 'prov', name: adapter.id },
    ];
    if (session) killTargets.push({ kind: 'sess', id: session });
    if (key.parentKeyId) killTargets.push({ kind: 'key', id: key.parentKeyId });
    const capTemplates: CapTemplate[] = [];
    if (sessionScope && key.sessionCapMicros) {
      capTemplates.push({ scope: sessionScope, kind: 'm', hard: BigInt(key.sessionCapMicros) });
    }
    if (key.agentId && key.agentDayCapMicros) {
      capTemplates.push({
        scope: { kind: 'agent', id: key.agentId },
        kind: 'd',
        hard: BigInt(key.agentDayCapMicros),
      });
    }

    const reqId = request.id;
    let remaining: bigint | null = null;
    let crossings: Crossing[] = [];
    let handle: ReservationHandle | null = null;
    let failOpenDay: string | null = null;
    try {
      const reserveStart = performance.now();
      const r = await engine.reserve({
        orgId: org.id,
        reqId,
        amount: priced.worst,
        scopes,
        killTargets,
        timeZone: org.timeZone,
        now: at,
        capTemplates,
        loop: {
          ...(key.loop ?? org.loop),
          keyId: key.id,
          hash: priced.hash,
          // The per-minute rule is per session (design doc); without one only identical
          // requests count.
          ...(sessionScope ? { rateScope: sessionScope } : {}),
        },
      });
      metrics.reserveLatency.observe(performance.now() - reserveStart);
      const base = {
        reqId,
        keyId: key.id,
        provider: adapter.id,
        route: priced.route,
        session,
        worstMicros: priced.worst.toString(),
      };
      switch (r.outcome) {
        case 'killed':
          emit(org.id, { type: 'blocked', reason: 'killed', target: r.target, ...base });
          return sendError(reply, 'killed', `Spending is switched off for ${r.target}. Stop.`, {
            target: r.target,
          });
        case 'loop_detected':
          emit(org.id, {
            type: r.tripped ? 'loop' : 'blocked',
            reason: 'loop_detected',
            hash: priced.hash,
            ...base,
          });
          reply.header('retry-after', String(r.retryAfterSec));
          return sendError(
            reply,
            'loop_detected',
            'Repeated requests detected; this key is paused. Stop and ask the user.',
            { retryAfter: r.retryAfterSec },
          );
        case 'budget_exceeded':
          reply.header('x-brake-remaining-micros', String(r.cap > r.used ? r.cap - r.used : 0n));
          emit(org.id, {
            type: 'blocked',
            reason: 'budget_exceeded',
            scope: r.scope,
            window: r.window,
            firstDeny: r.firstDeny ? '1' : '0',
            ...base,
          });
          return sendError(
            reply,
            'budget_exceeded',
            `Spend cap reached for ${r.scope}. Stop and ask the user to raise the cap.`,
            {
              scope: r.scope,
              window: r.window,
              cap: micros(r.cap),
              spent: micros(r.used),
              resetsAt: r.resetsAt.toISOString(),
            },
          );
        case 'ok':
          remaining = r.remaining;
          crossings = r.crossings;
          handle = r.handle;
      }
    } catch (err) {
      if (!key.failOpenMicros) {
        request.log.warn({ err: (err as Error).message }, 'reserve failed');
        return sendError(reply, 'budget_unavailable', 'Budget store unavailable; request blocked.');
      }
      failOpenDay = at.toISOString().slice(0, 10);
      const allowance = BigInt(key.failOpenMicros);
      if (!local.tryReserve(key.id, failOpenDay, priced.worst, allowance)) {
        const nextDay = new Date(`${failOpenDay}T00:00:00Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        reply.header('x-brake-remaining-micros', '0');
        return sendError(
          reply,
          'budget_exceeded',
          'Budget store unavailable and the fail-open allowance is used up.',
          {
            scope: `key:${key.id}`,
            window: `d:${failOpenDay.replaceAll('-', '')}`,
            cap: Number(allowance),
            spent: Number(local.used(key.id, failOpenDay)),
            resetsAt: nextDay.toISOString(),
          },
        );
      }
      reply.header('x-brake-fail-open', '1');
    }

    // Settle in the background so the response is not held up. One script commits, counts units
    // and appends the usage event; if it fails, the sweeper commits the reservation at worst case.
    // `billed`: the provider charges for this request at list price, so its units count toward
    // volume bands and the free allowance even when our price for it is zero.
    const settle = (
      actual: bigint,
      billed: boolean,
      status: number,
      upstreamMs: number,
      error?: string,
      keyError = false,
      pendingRef: Record<string, string> | null = null,
    ) => {
      metrics.cost.inc({ provider: adapter.id }, Number(actual));
      const event = compact({
        type: 'usage',
        reqId,
        keyId: key.id,
        provider: adapter.id,
        route: priced.route,
        skus: priced.items.map((i) => i.sku).join(','),
        units: priced.items.map((i) => i.units.toString()).join(','),
        worstMicros: priced.worst.toString(),
        costMicros: actual.toString(),
        status: String(status),
        upstreamMs: upstreamMs.toFixed(1),
        latencyMs: (performance.now() - started).toFixed(1),
        hash: priced.hash,
        session,
        env: key.env ?? undefined,
        agentId: key.agentId ?? undefined,
        // Marks were set at reserve; only announce them for spend that actually happened.
        crossings: billed && crossings.length ? JSON.stringify(crossings) : undefined,
        failOpen: failOpenDay ? '1' : undefined,
        keyError: keyError ? '1' : undefined,
        error,
      });
      if (failOpenDay) {
        local.settle(key.id, failOpenDay, priced.worst, actual);
        if (billed || actual > 0n) {
          local.journal.push({
            orgId: org.id,
            scopes,
            amount: actual,
            timeZone: org.timeZone,
            at,
            units: billed ? priced.items : [],
            event,
          });
        }
        return;
      }
      track(
        (async () => {
          try {
            await engine.settle(org.id, reqId, actual, handle!, {
              billed,
              timeZone: org.timeZone,
              now: at,
              units: priced.items,
              event,
            });
            // Providers that price later (Twilio): settle the real price in the worker.
            if (billed && pendingRef) {
              await engine.addPending(
                org.id,
                reqId,
                {
                  provider: adapter.id,
                  credentialId,
                  scopes: scopes.map(scopeLabel),
                  at: at.toISOString(),
                  timeZone: org.timeZone,
                  committedMicros: actual.toString(),
                  ref: pendingRef,
                  keyId: key.id,
                },
                new Date(at.getTime() + 120_000),
              );
            }
            // Every accepted request counts toward the session, including the free ones (later
            // keystrokes, the request that closes it).
            // A request that closes the session closes it whatever the answer: keeping it open
            // could make the next session look free.
            if (
              billingSessionHash &&
              billingSession &&
              priced.classified &&
              (adapter.billedOnStatus(status, priced.classified) ||
                (billingSession.ends === true && status > 0))
            ) {
              await engine.recordBillingSessionCall(
                org.id,
                adapter.id,
                billingSessionHash,
                billingSession.ttlSec,
                { sliding: billingSession.sliding ?? false, end: billingSession.ends ?? false },
              );
            }
          } catch (err) {
            app.log.warn(
              { reqId, err: (err as Error).message },
              'settle failed; sweeper will commit',
            );
          }
        })(),
      );
    };

    const costHeaders = (actual: bigint) => {
      reply.header('x-brake-cost-micros', actual.toString());
      if (remaining !== null) {
        reply.header('x-brake-remaining-micros', (remaining + priced.worst - actual).toString());
      }
    };

    // 5. Forward.
    let secret: string;
    try {
      secret = await deps.secrets.get(org.id, adapter.id, credentialId);
    } catch {
      settle(0n, false, 0, 0, 'credential_unavailable');
      return sendError(reply, 'upstream_unavailable', 'Provider credential is not available.');
    }
    const headers = outgoingHeaders(request.headers);
    const outgoing = { origin: upstream.origin, headers, query };
    adapter.injectCredential(outgoing, secret);
    const base = deps.upstreamOverrides?.[upstream.origin] ?? upstream.origin;
    const url = upstreamUrl(base, path, outgoing.query);

    const upstreamStart = performance.now();
    let res: Dispatcher.ResponseData;
    try {
      res = await undiciRequest(url, {
        method: request.method,
        headers: outgoing.headers,
        body: rawBody && rawBody.length > 0 ? rawBody : null,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        ...(deps.dispatcher ? { dispatcher: deps.dispatcher } : {}),
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code;
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      const neverSent = [code, cause].some((c) =>
        ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(c ?? ''),
      );
      const upstreamMs = performance.now() - upstreamStart;
      if (neverSent) {
        settle(0n, false, 0, upstreamMs, 'upstream_unreachable');
        costHeaders(0n);
        return sendError(reply, 'upstream_unavailable', 'Provider unreachable; nothing billed.');
      }
      // The provider may have received and billed it.
      const actual = adapter.timeoutBilled ? priced.worst : 0n;
      metrics.upstreamLatency.observe({ provider: adapter.id }, upstreamMs);
      settle(actual, adapter.timeoutBilled, 0, upstreamMs, code ?? 'upstream_error');
      costHeaders(actual);
      return sendError(reply, 'upstream_timeout', 'Provider did not answer in time.');
    }
    const upstreamMs = performance.now() - upstreamStart;
    metrics.upstreamLatency.observe({ provider: adapter.id }, upstreamMs);
    const resHeaders = res.headers as Record<string, string | undefined>;

    // 6. Settle from the response, then 7. emit (inside settle). The list price decides whether
    // the provider billed; a trusted free allowance then prices it from fresh (uncached) counts.
    const actualOf = async (body?: unknown): Promise<{ actual: bigint; billed: boolean }> => {
      if (!priced.classified) {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        return { actual: ok ? priced.worst : 0n, billed: ok };
      }
      const upstreamRes = {
        status: res.statusCode,
        headers: resHeaders,
        ...(body !== undefined ? { body } : {}),
      };
      const list = adapter.actual(priced.classified, upstreamRes, ctx);
      if (list === 0n || !providerCfg.trustFreeTier || failOpenDay) {
        return { actual: list, billed: list > 0n };
      }
      try {
        const fresh = await engine.monthlyUnits(
          org.id,
          [...new Set(priced.items.map((i) => i.sku))],
          org.timeZone,
          at,
        );
        const free = adapter.actual(priced.classified, upstreamRes, {
          monthlyUnits: fresh,
          trustFreeTier: true,
        });
        return { actual: free, billed: true };
      } catch {
        return { actual: list, billed: true };
      }
    };

    const passHeaders = responseHeaders(res.headers);

    // Error responses are small; buffering them lets the adapter see whether the provider rejected
    // our key, which raises an alert.
    if ((priced.classified && adapter.needsBody(priced.classified)) || res.statusCode >= 400) {
      let raw: Buffer;
      try {
        raw = await readLimited(res.body, maxBuffered);
      } catch (err) {
        const { actual, billed } = await actualOf();
        settle(actual, billed, res.statusCode, upstreamMs, (err as Error).message);
        costHeaders(actual);
        return sendError(reply, 'upstream_unavailable', 'Provider response failed mid-way.');
      }
      let body: unknown;
      try {
        body = parseJson(decodeBody(raw, resHeaders['content-encoding']));
      } catch {
        body = undefined;
      }
      const { actual, billed } = await actualOf(body);
      const keyError = adapter.credentialRejected({
        status: res.statusCode,
        headers: resHeaders,
        ...(body !== undefined ? { body } : {}),
      });
      const upstreamRes = {
        status: res.statusCode,
        headers: resHeaders,
        ...(body !== undefined ? { body } : {}),
      };
      const pendingRef = priced.classified
        ? (adapter.pendingSettlement?.(priced.classified, upstreamRes) ?? null)
        : null;
      settle(actual, billed, res.statusCode, upstreamMs, undefined, keyError, pendingRef);
      reply.code(res.statusCode).headers(passHeaders);
      costHeaders(actual);
      return reply.send(raw);
    }

    const { actual, billed } = await actualOf();
    settle(actual, billed, res.statusCode, upstreamMs);
    reply.code(res.statusCode).headers(passHeaders);
    costHeaders(actual);
    return reply.send(res.body);
  });

  return app;
}

/** Logger options that keep credentials out of every log line. */
export const loggerOptions = (level: string): FastifyServerOptions['logger'] =>
  redactingLoggerOptions(level);

async function readLimited(body: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('response too large to price');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
