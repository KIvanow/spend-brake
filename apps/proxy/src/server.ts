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
  type PauseReason,
  Registry,
  type ReservationHandle,
  type ScopeShare,
  type Scope,
  type ValkeyClient,
  isVirtualKey,
  scopeLabel,
  shareOf,
  windowsFor,
} from '@spend-brake/budget';
import { Transform, type TransformCallback, pipeline } from 'node:stream';
import {
  CUSTOM_PREFIX,
  GenericAdapter,
  type IncomingReq,
  type LineItem,
  type PriceCtx,
  type PricedClassified,
  type ProviderAdapter,
  type Upstream,
} from '@spend-brake/catalog';
import {
  type GuardedClient,
  PRIVATE_ADDRESS,
  answers,
  guardedAgent,
  privateLiteralHost,
  redactUrl,
  redactingLoggerOptions,
} from '@spend-brake/shared';
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
  DecodedTooLarge,
  decodeBody,
  outgoingHeaders,
  parseBody,
  parseJson,
  responseHeaders,
  upstreamUrl,
} from './forward.js';
import { JournalDir, LocalBudget, serializeJournal } from './local-budget.js';
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
  /**
   * Outbound client for orgs' custom APIs (their origins are user input): refuses private
   * addresses unless built with allowPrivate. Built-in providers use `dispatcher`.
   */
  customEgress?: GuardedClient;
  /** Largest custom API response passed on (default 10 MB); a longer one is cut. */
  customMaxResponseBytes?: number;
  now?: () => Date;
  metrics?: ProxyMetrics;
  /** How often fail-open spend is retried into Valkey. */
  replayIntervalMs?: number;
  /**
   * Directory where fail-open spend that could not reach Valkey by shutdown is kept, to be
   * replayed after the next start. Without it, that spend is only logged.
   */
  failOpenJournalDir?: string;
  /**
   * How long a journal file another proxy claimed may go untouched before this one takes it over
   * at start (that proxy was killed mid-replay). Defaults to the stop grace period.
   */
  failOpenStaleClaimMs?: number;
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
/**
 * How error messages name a key: `key "web app" (key_…)`, or by id alone when its record has no
 * name (written before records carried one). Names are the org's own labels, never request
 * data; control characters and line or paragraph separators become spaces so the message stays one
 * line, and bidi marks, embeddings, overrides, isolates and zero-width characters are dropped so a
 * name cannot reorder or hide part of the message on screen.
 */
export function keyLabel(key: Pick<KeyRecord, 'id' | 'name'>): string {
  const name = key.name
    // eslint-disable-next-line no-control-regex
    ?.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .trim();
  return name ? `key "${name}" (${key.id})` : `key ${key.id}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A cap or kill scope in words: the caller's own key (and its parent) by name where known. */
function scopeInWords(scope: string, key: KeyRecord): string {
  if (scope === `key:${key.id}`) return keyLabel(key);
  if (key.parentKeyId && scope === `key:${key.parentKeyId}`) {
    return `the key that minted this session key (${scope})`;
  }
  return scope;
}

/** 429 loop_detected messages by what opened the key's circuit (it pauses the whole key). */
const PAUSED_MESSAGE: Record<PauseReason, (key: string) => string> = {
  loop: (key) =>
    `Repeated requests detected; ${key} is paused for all providers. Stop and ask the user.`,
  pumping: (key) =>
    `Too many messages to one number or number range (possible SMS pumping); ${key} is paused for all providers. Stop and ask the user.`,
};
// Where a provider's own key goes, so a virtual key can take its place: Google `key`, Mapbox
// `access_token`, HERE `apiKey`.
const DROP_IN_PARAMS = ['key', 'access_token', 'apiKey', 'api_key'];
const DROP_IN_HEADERS = ['x-goog-api-key', 'x-api-key', 'x-subscription-token'];

interface Route {
  adapter: ProviderAdapter;
  upstream: Upstream;
}

/** Custom API ids, as the admin API accepts them. */
const CUSTOM_ID = /^[A-Za-z0-9_.-]{1,128}$/;
/** An org's custom APIs by id, or why one could not be loaded. */
type CustomApis = Map<string, GenericAdapter | string>;

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
  const customEgress = deps.customEgress ?? guardedAgent(false, 'custom API');
  const customMax = deps.customMaxResponseBytes ?? 10 * 1024 * 1024;
  // Org custom API definitions, reloaded like keys: the admin API rewrites them in Valkey and
  // this cache picks the change up within the config TTL.
  const customCache = new TtlCache<CustomApis>(configTtl, CONFIG_STALE_MS);

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
    if (request.url !== '/healthz' && request.url !== '/readyz') {
      const l = labels.get(request) ?? { provider: '', sku: '' };
      metrics.requests.inc({ ...l, outcome: outcomes.get(request) ?? 'ok' });
    }
    done();
  });

  // Fail-open spend kept by earlier shutdowns that could not reach Valkey.
  const journalDir = deps.failOpenJournalDir
    ? new JournalDir(deps.failOpenJournalDir, deps.failOpenStaleClaimMs)
    : null;
  if (journalDir) {
    local.journal.push(
      ...journalDir.load((file, err) =>
        app.log.error({ err: err.message, file }, 'unreadable fail-open journal set aside'),
      ),
    );
  }

  // Fail-open spend is recorded once Valkey answers again, so the ledger, alerts and the next
  // windows see it. One run at a time: two would both record journal[0]. Each entry is recorded
  // under its id, so a retry after a lost reply (or a replay of a file already recorded) is a
  // no-op.
  let replaying: Promise<number> | null = null;
  async function replayFailOpen(): Promise<number> {
    if (replaying) {
      await replaying;
      return 0;
    }
    replaying = replayJournal();
    try {
      return await replaying;
    } finally {
      replaying = null;
    }
  }
  async function replayJournal(): Promise<number> {
    let n = 0;
    while (local.journal.length > 0) {
      const e = local.journal[0]!;
      let recorded: boolean;
      try {
        recorded = await engine.recordSpend({
          id: e.id,
          orgId: e.orgId,
          amount: e.amount,
          scopes: e.scopes,
          scopeShares: e.scopeShares,
          timeZone: e.timeZone,
          at: e.at,
          units: e.units,
          event: e.event,
        });
      } catch {
        break;
      }
      local.journal.shift();
      if (!recorded) continue; // an earlier attempt got through
      metrics.failOpenReplayed.inc();
      n++;
    }
    if (local.journal.length === 0 && journalDir?.holding) {
      try {
        await journalDir.release();
      } catch (err) {
        app.log.error({ err: (err as Error).message }, 'could not remove a replayed journal');
      }
    }
    return n;
  }
  const replayTimer = setInterval(() => {
    if (journalDir?.holding) track(journalDir.refresh());
    if (local.journal.length > 0 && !replaying) track(replayFailOpen());
  }, deps.replayIntervalMs ?? 5_000);
  replayTimer.unref();

  // Fail-open spend lives only in memory: record it before exiting, or keep it on disk.
  app.addHook('onClose', async () => {
    clearInterval(replayTimer);
    await Promise.allSettled([...pending]);
    if (local.journal.length === 0) return;
    await replayFailOpen();
    if (local.journal.length === 0) return;
    try {
      if (journalDir) {
        const file = await journalDir.save(local.journal);
        app.log.warn(
          { entries: local.journal.length, file },
          'fail-open spend kept for the next start',
        );
        return;
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message }, 'could not keep fail-open spend');
    }
    // Last resort: the operator can still record it by hand.
    app.log.error(
      { entries: JSON.parse(serializeJournal(local.journal)) as unknown },
      'fail-open spend not recorded',
    );
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

  // Liveness: the process answers. Readiness: it can also reach Valkey, so a load balancer sends
  // traffic elsewhere while it cannot (only fail-open keys would get through here).
  app.get('/healthz', () => ({ ok: true, service: 'proxy' }));
  app.get('/readyz', async (_request, reply) => {
    const valkey = await answers(() => deps.valkey.ping());
    return reply.code(valkey ? 200 : 503).send({ ok: valkey, valkey });
  });

  function track(p: Promise<unknown>): void {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  function emit(orgId: string, event: Record<string, string | undefined>): void {
    track(engine.emit(orgId, compact(event)).catch(() => undefined));
  }

  /**
   * The provider a path is for: a built-in or operator adapter by prefix, or an org custom API
   * (`/custom/<id>/...`), which is resolved only once the key says whose org it is.
   */
  function findRoute(
    url: string,
  ): { route: Route | null; customId?: string; path: string; query: URLSearchParams } | null {
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    const custom = new RegExp(`^${CUSTOM_PREFIX}/([^/]+)(/.*)$`).exec(pathname);
    if (custom) {
      if (!CUSTOM_ID.test(custom[1]!)) return null;
      return {
        route: null,
        customId: custom[1]!,
        path: custom[2]!,
        query: new URLSearchParams(q === -1 ? '' : url.slice(q + 1)),
      };
    }
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

  async function loadCustomApis(orgId: string): Promise<CustomApis> {
    const apis: CustomApis = new Map();
    for (const record of await registry.getCustomApis(orgId)) {
      const id = (record as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') continue;
      try {
        apis.set(id, GenericAdapter.fromCustomApi(record));
      } catch {
        apis.set(id, 'invalid');
      }
    }
    return apis;
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
    const { path, query } = found;
    if (found.route) labels.set(request, { provider: found.route.adapter.id, sku: '' });

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
    const { org } = auth;
    // Custom APIs belong to an org: the same id in two orgs is two different APIs.
    let route = found.route;
    if (!route) {
      let apis: CustomApis;
      try {
        apis = (await customCache.get(org.id, () => loadCustomApis(org.id))).value;
      } catch {
        return sendError(reply, 'budget_unavailable', 'Budget store unavailable; request blocked.');
      }
      const api = apis.get(found.customId!);
      if (api === undefined) {
        return sendError(reply, 'unknown_route', 'Your org has no custom API with this id.');
      }
      if (typeof api === 'string') {
        return sendError(
          reply,
          'unknown_route',
          'This custom API could not be loaded by the proxy; save it again in the dashboard.',
        );
      }
      route = { adapter: api, upstream: api.upstreams[0] };
      labels.set(request, { provider: api.id, sku: '' });
    }
    const { adapter, upstream } = route;
    const custom = found.route === null;
    const credentialId = key.credentials[adapter.id];
    if (!credentialId) {
      return sendError(
        reply,
        'sku_not_allowed',
        `${capitalize(keyLabel(key))} may not call provider ${adapter.id}.`,
      );
    }
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
    // What the org's own telemetry gets about the call (never query strings or bodies: they hold
    // addresses, phone numbers and search terms).
    const call = callInfo(request.headers, rawBody);
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
      const session =
        billingSessionHash === null || billingSession === null
          ? { calls: 0, ttlLeftSec: 0 }
          : await engine.billingSessionState(org.id, adapter.id, billingSessionHash);
      const calls = session.calls;
      const c = adapter.classify(incoming, {
        billingSessionStarted: calls > 0,
        billingSessionCalls: calls,
        // A fixed TTL runs from the session's first request, so what is gone of it is its age.
        billingSessionAgeSec:
          calls > 0 && billingSession && !billingSession.sliding
            ? billingSession.ttlSec - session.ttlLeftSec
            : 0,
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
          ...call,
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
      return sendError(
        reply,
        'sku_not_allowed',
        `${capitalize(keyLabel(key))} may not call this SKU.`,
        {
          skus: priced.items.map((i) => i.sku),
        },
      );
    }

    // Messaging: destination country allow-list and the pumping guard, before any money moves.
    const dest = priced.classified?.destination;
    if (dest) {
      const allowed = key.countries ?? DEFAULT_COUNTRIES;
      if (!dest.country || !allowed.includes(dest.country)) {
        emit(org.id, {
          ...call,
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
          `${capitalize(keyLabel(key))} may not send to ${dest.country ?? 'that number'}; allowed: ${allowed.join(', ')}.`,
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
            ...call,
            type: pump.tripped ? 'loop' : 'blocked',
            reason: pump.reason === 'pumping' ? 'pumping' : 'loop_detected',
            reqId: request.id,
            keyId: key.id,
            provider: adapter.id,
            prefix: dest.prefix,
          });
          reply.header('retry-after', String(pump.retryAfterSec));
          return sendError(reply, 'loop_detected', PAUSED_MESSAGE[pump.reason](keyLabel(key)), {
            retryAfter: pump.retryAfterSec,
            reason: pump.reason,
          });
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
    const scopes: Scope[] = [{ kind: 'org' }, { kind: 'key', id: key.id }];
    // Every SKU a request bills counts against its own SKU's scope: alone, with the whole
    // amount; next to others, with just its own line items.
    const skus = [...new Set(priced.items.map((i) => i.sku))];
    const scopeShares: ScopeShare[] = [];
    if (skus.length === 1) {
      scopes.push({ kind: 'sku', provider: adapter.id, sku: skus[0]! });
    } else {
      for (const sku of skus) {
        const own = priced.items.filter((i) => i.sku === sku);
        const amount = priced.classified
          ? adapter.worstCase({ ...priced.classified, items: own }, ctx)
          : priced.worst;
        scopeShares.push({
          scope: { kind: 'sku', provider: adapter.id, sku },
          amount: amount < priced.worst ? amount : priced.worst,
        });
      }
    }
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
        scopeShares,
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
          emit(org.id, {
            ...call,
            type: 'blocked',
            reason: 'killed',
            target: r.target,
            ...base,
          });
          return sendError(
            reply,
            'killed',
            `Spending is switched off for ${scopeInWords(r.target, key)}. Stop.`,
            { target: r.target },
          );
        case 'loop_detected':
          emit(org.id, {
            ...call,
            type: r.tripped ? 'loop' : 'blocked',
            reason: r.reason === 'pumping' ? 'pumping' : 'loop_detected',
            hash: priced.hash,
            ...base,
          });
          reply.header('retry-after', String(r.retryAfterSec));
          return sendError(reply, 'loop_detected', PAUSED_MESSAGE[r.reason](keyLabel(key)), {
            retryAfter: r.retryAfterSec,
            reason: r.reason,
          });
        case 'budget_exceeded':
          reply.header('x-brake-remaining-micros', String(r.cap > r.used ? r.cap - r.used : 0n));
          emit(org.id, {
            ...call,
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
            `Spend cap reached for ${scopeInWords(r.scope, key)}. Stop and ask the user to raise the cap.`,
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
          `Budget store unavailable and the fail-open allowance of ${keyLabel(key)} is used up.`,
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
    // Response size, once known (streamed responses report their Content-Length).
    let resBytes: number | undefined;
    // Reported pricing (custom APIs): the cost was missing (charged at the max) or above the max.
    let costNote: string | null = null;
    const settle = (
      actual: bigint,
      billed: boolean,
      status: number,
      upstreamMs: number,
      error?: string,
      keyError = false,
      pendingRef: Record<string, string> | null = null,
      providerError: string | null = null,
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
        providerError: providerError ?? undefined,
        costNote: costNote ?? undefined,
        error,
        ...call,
        resBytes: resBytes === undefined ? undefined : String(resBytes),
      });
      if (failOpenDay) {
        local.settle(key.id, failOpenDay, priced.worst, actual);
        if (billed || actual > 0n) {
          local.journal.push({
            id: randomUUID(),
            orgId: org.id,
            scopes,
            scopeShares: scopeShares.map((s) => ({
              scope: s.scope,
              amount: shareOf(actual, priced.worst, s.amount),
            })),
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
      // Not the provider's fault: the stored provider key is gone (deleted) or cannot be read.
      return sendError(
        reply,
        'upstream_unavailable',
        `The ${adapter.id} provider key that Spend Brake ${keyLabel(key)} uses was deleted or cannot be read; nothing was sent. Point the key at another provider key in the dashboard (Keys).`,
      );
    }
    const headers = outgoingHeaders(request.headers);
    const outgoing = { origin: upstream.origin, headers, query };
    adapter.injectCredential(outgoing, secret);
    const base = deps.upstreamOverrides?.[upstream.origin] ?? upstream.origin;
    const url = upstreamUrl(base, path, outgoing.query);
    const privateRefused = () => {
      settle(0n, false, 0, 0, 'private_address');
      return sendError(
        reply,
        'upstream_unavailable',
        'This custom API points at a private address, which this proxy does not call; nothing was sent.',
      );
    };
    // Custom API origins are user input: hostnames are checked when connecting (guarded agent),
    // IP literals here, since no DNS lookup happens for them.
    if (custom && !customEgress.allowPrivate && privateLiteralHost(url.href)) {
      return privateRefused();
    }

    const upstreamStart = performance.now();
    let res: Dispatcher.ResponseData;
    try {
      const dispatcher = custom ? customEgress.agent : deps.dispatcher;
      res = await undiciRequest(url, {
        method: request.method,
        headers: outgoing.headers,
        body: rawBody && rawBody.length > 0 ? rawBody : null,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } }).code;
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if (code === PRIVATE_ADDRESS || cause === PRIVATE_ADDRESS) return privateRefused();
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
    const length = Number(resHeaders['content-length']);
    if (Number.isSafeInteger(length) && length >= 0) resBytes = length;

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
      costNote = adapter.costNote?.(priced.classified, upstreamRes) ?? null;
      if (costNote) {
        request.log.warn(
          { provider: adapter.id, route: priced.route, costNote, costMicros: list.toString() },
          costNote === 'over_max'
            ? 'reported cost is above the route maximum; charged in full'
            : 'no cost reported; charged the route maximum',
        );
      }
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
        raw = custom
          ? await readLimited(res.body, Math.min(maxBuffered, customMax), 'response_too_large')
          : await readLimited(res.body, maxBuffered);
      } catch (err) {
        const { actual, billed } = await actualOf();
        settle(actual, billed, res.statusCode, upstreamMs, (err as Error).message);
        costHeaders(actual);
        return sendError(
          reply,
          'upstream_unavailable',
          (err as Error).message === 'response_too_large'
            ? `The custom API answered with more than ${customMax} bytes; the response was cut.`
            : 'Provider response failed mid-way.',
        );
      }
      resBytes = raw.length;
      let body: unknown;
      try {
        body = parseJson(await decodeBody(raw, resHeaders['content-encoding'], 2 * maxBuffered));
      } catch (err) {
        if (err instanceof DecodedTooLarge) {
          // Unreadable, so nothing in it may lower the price: charge the worst case.
          settle(priced.worst, true, res.statusCode, upstreamMs, err.message);
          costHeaders(priced.worst);
          return sendError(
            reply,
            'upstream_unavailable',
            'Provider response inflates past the size the proxy reads.',
          );
        }
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
      // A refusal inside a 200 (Google's legacy JSON status) is an error, not a success.
      const providerError = priced.classified
        ? (adapter.providerError?.(priced.classified, upstreamRes) ?? null)
        : null;
      settle(
        actual,
        billed,
        res.statusCode,
        upstreamMs,
        undefined,
        keyError,
        pendingRef,
        providerError,
      );
      reply.code(res.statusCode).headers(passHeaders);
      costHeaders(actual);
      return reply.send(raw);
    }

    const { actual, billed } = await actualOf();
    if (custom) {
      // Custom API responses are size-limited: one announced as too long is not passed on, and
      // a stream that runs past the limit is cut. Settled once the stream ends either way.
      if (resBytes !== undefined && resBytes > customMax) {
        res.body.destroy();
        settle(actual, billed, res.statusCode, upstreamMs, 'response_too_large');
        costHeaders(actual);
        return sendError(
          reply,
          'upstream_unavailable',
          `The custom API answered with more than ${customMax} bytes; the response was cut.`,
        );
      }
      const limited = new ByteLimit(customMax);
      track(
        new Promise<void>((resolve) => {
          pipeline(res.body, limited, () => {
            resBytes = limited.bytes;
            if (limited.cut) outcomes.set(request, 'upstream_unavailable');
            settle(
              actual,
              billed,
              res.statusCode,
              upstreamMs,
              limited.cut ? 'response_too_large' : undefined,
            );
            resolve();
          });
        }),
      );
      reply.code(res.statusCode).headers(passHeaders);
      costHeaders(actual);
      return reply.send(limited);
    }
    settle(actual, billed, res.statusCode, upstreamMs);
    reply.code(res.statusCode).headers(passHeaders);
    costHeaders(actual);
    return reply.send(res.body);
  });

  return app;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Per-call details for the org's telemetry: the caller's W3C trace context (so the call shows up
 * inside their own trace), user agent and request size.
 */
export function callInfo(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer | undefined,
): Record<string, string | undefined> {
  const tp = headers.traceparent;
  const m = typeof tp === 'string' ? TRACEPARENT.exec(tp.trim()) : null;
  // All-zero ids are invalid per the W3C spec.
  const valid = m && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!);
  const ua = headers['user-agent'];
  return {
    traceId: valid ? m[1] : undefined,
    parentSpanId: valid ? m[2] : undefined,
    // Printable ASCII only, bounded: it is client-controlled.
    userAgent:
      typeof ua === 'string'
        ? ua.replace(/[^\x20-\x7e]/g, '').slice(0, 200) || undefined
        : undefined,
    reqBytes: body ? String(body.length) : undefined,
  };
}

/** Logger options that keep credentials out of every log line. */
export const loggerOptions = (level: string): FastifyServerOptions['logger'] =>
  redactingLoggerOptions(level);

async function readLimited(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  tooLarge = 'response too large to price',
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(tooLarge);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Passes bytes through until `limit`, then fails the stream (the client sees it cut). */
class ByteLimit extends Transform {
  bytes = 0;
  cut = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.cut = true;
      done(new Error('response_too_large'));
      return;
    }
    done(null, chunk);
  }
}
