import { createHash, randomUUID } from 'node:crypto';
import {
  BudgetEngine,
  type CapTemplate,
  type Crossing,
  DEFAULT_LOOP_POLICY,
  type KeyRecord,
  type KillTarget,
  type OrgRecord,
  Registry,
  type ReservationHandle,
  type Scope,
  type ValkeyClient,
  isVirtualKey,
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
import { sendError } from './errors.js';
import { decodeBody, outgoingHeaders, parseJson, responseHeaders, upstreamUrl } from './forward.js';
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
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Wait for background settlement (commit, units, events) to finish. */
    brakeDrain(): Promise<void>;
  }
}

const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const CONFIG_STALE_MS = 10 * 60_000;
const DEFAULT_SKU = 'unpriced';

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
  const keyCache = new TtlCache<KeyRecord | null>(configTtl, CONFIG_STALE_MS);
  const orgCache = new TtlCache<OrgRecord | null>(configTtl, CONFIG_STALE_MS);
  // Unit counts only grow, so a stale count can only select a pricier volume band.
  const unitsCache = new TtlCache<bigint>(configTtl, 0);
  const local = new LocalBudget();
  const pending = new Set<Promise<unknown>>();
  const timeout = deps.upstreamTimeoutMs ?? 30_000;
  const maxBuffered = deps.maxBufferedBytes ?? 32 * 1024 * 1024;

  const routes: Route[] = deps.adapters.flatMap((adapter) =>
    adapter.upstreams.map((upstream) => ({ adapter, upstream })),
  );

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

  app.addHook('onClose', async () => {
    await Promise.allSettled([...pending]);
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
    const param = query.get('key');
    if (param && isVirtualKey(param)) return param;
    const goog = request.headers['x-goog-api-key'];
    if (typeof goog === 'string' && isVirtualKey(goog)) return goog;
    return null;
  }

  async function authenticate(token: string): Promise<Auth | null> {
    const k = await keyCache.get(token, () => registry.getKeyByToken(token));
    const key = k.value;
    if (!key) return null;
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
    const found = findRoute(request.url);
    if (!found)
      return sendError(reply, 'unknown_route', 'No provider is configured for this path.');
    const { route, path, query } = found;
    const { adapter, upstream } = route;

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
    const session = request.headers['x-brake-session'];
    if (session !== undefined && (typeof session !== 'string' || !SESSION_ID.test(session))) {
      return sendError(reply, 'invalid_request', 'Invalid X-Brake-Session.');
    }
    query.delete('key');

    // 2. Classify and price.
    const rawBody = Buffer.isBuffer(request.body) ? request.body : undefined;
    const incoming: IncomingReq = {
      method: request.method,
      origin: upstream.origin,
      path,
      query,
      headers: request.headers as Record<string, string | undefined>,
      body: parseJson(rawBody, request.headers['content-type']),
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
    let ctx: PriceCtx = { monthlyUnits: new Map(), trustFreeTier: providerCfg.trustFreeTier };
    try {
      const started =
        billingSessionHash !== null &&
        (await engine.isBillingSessionStarted(org.id, adapter.id, billingSessionHash));
      const c = adapter.classify(incoming, { billingSessionStarted: started });
      if (c.priced) {
        ctx = {
          monthlyUnits: await monthlyUnits(org, [...new Set(c.items.map((i) => i.sku))], at),
          trustFreeTier: providerCfg.trustFreeTier,
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
    if (key.skus && !priced.items.every((i) => key.skus!.includes(i.sku))) {
      return sendError(reply, 'sku_not_allowed', 'Key may not call this SKU.', {
        skus: priced.items.map((i) => i.sku),
      });
    }

    // 3-4. Loop check and reserve, in one atomic script.
    const sessionScope: Scope | null = session ? { kind: 'sess', id: session } : null;
    const scopes: Scope[] = [
      { kind: 'org' },
      { kind: 'key', id: key.id },
      // Multi-SKU requests count against their primary SKU's scope.
      { kind: 'sku', provider: adapter.id, sku: priced.items[0]!.sku },
    ];
    if (key.env) scopes.push({ kind: 'env', name: key.env });
    if (key.agentId) scopes.push({ kind: 'agent', id: key.agentId });
    if (sessionScope) scopes.push(sessionScope);
    const killTargets: KillTarget[] = [
      { kind: 'org' },
      { kind: 'key', id: key.id },
      { kind: 'prov', name: adapter.id },
    ];
    if (session) killTargets.push({ kind: 'sess', id: session });
    const capTemplates: CapTemplate[] =
      sessionScope && key.sessionCapMicros
        ? [{ scope: sessionScope, kind: 'm', hard: BigInt(key.sessionCapMicros) }]
        : [];

    const reqId = request.id;
    let remaining: bigint | null = null;
    let crossings: Crossing[] = [];
    let handle: ReservationHandle | null = null;
    let failOpenDay: string | null = null;
    try {
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
          rateScope: sessionScope ?? { kind: 'key', id: key.id },
        },
      });
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
      if (!local.tryReserve(key.id, failOpenDay, priced.worst, BigInt(key.failOpenMicros))) {
        return sendError(
          reply,
          'budget_exceeded',
          'Budget store unavailable and the fail-open allowance is used up.',
          { scope: `key:${key.id}`, window: `d:${failOpenDay.replaceAll('-', '')}` },
        );
      }
      reply.header('x-brake-fail-open', '1');
    }

    // Settle in the background so the response is not held up. One script commits, counts units
    // and appends the usage event; if it fails, the sweeper commits the reservation at worst case.
    const settle = (actual: bigint, status: number, upstreamMs: number, error?: string) => {
      if (failOpenDay) {
        local.settle(key.id, failOpenDay, priced.worst, actual);
        return;
      }
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
        crossings: crossings.length ? JSON.stringify(crossings) : undefined,
        error,
      });
      track(
        (async () => {
          try {
            await engine.settle(org.id, reqId, actual, handle!, {
              timeZone: org.timeZone,
              now: at,
              units: priced.items,
              event,
            });
            if (actual > 0n && billingSessionHash && billingSession) {
              await engine.startBillingSession(
                org.id,
                adapter.id,
                billingSessionHash,
                billingSession.ttlSec,
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
      settle(0n, 0, 0, 'credential_unavailable');
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
        settle(0n, 0, upstreamMs, 'upstream_unreachable');
        costHeaders(0n);
        return sendError(reply, 'upstream_unavailable', 'Provider unreachable; nothing billed.');
      }
      // The provider may have received and billed it.
      const actual = adapter.timeoutBilled ? priced.worst : 0n;
      settle(actual, 0, upstreamMs, code ?? 'upstream_error');
      costHeaders(actual);
      return sendError(reply, 'upstream_timeout', 'Provider did not answer in time.');
    }
    const upstreamMs = performance.now() - upstreamStart;
    const resHeaders = res.headers as Record<string, string | undefined>;

    // 6. Settle from the response, then 7. emit (inside settle).
    const actualOf = (body?: unknown): bigint => {
      if (!priced.classified) {
        return res.statusCode >= 200 && res.statusCode < 300 ? priced.worst : 0n;
      }
      return adapter.actual(
        priced.classified,
        { status: res.statusCode, headers: resHeaders, ...(body !== undefined ? { body } : {}) },
        ctx,
      );
    };

    const passHeaders = responseHeaders(res.headers);

    if (priced.classified && adapter.needsBody(priced.classified)) {
      let raw: Buffer;
      try {
        raw = await readLimited(res.body, maxBuffered);
      } catch (err) {
        const actual = actualOf();
        settle(actual, res.statusCode, upstreamMs, (err as Error).message);
        costHeaders(actual);
        return sendError(reply, 'upstream_unavailable', 'Provider response failed mid-way.');
      }
      let body: unknown;
      try {
        body = parseJson(
          decodeBody(raw, resHeaders['content-encoding']),
          resHeaders['content-type'],
        );
      } catch {
        body = undefined;
      }
      const actual = actualOf(body);
      settle(actual, res.statusCode, upstreamMs);
      reply.code(res.statusCode).headers(passHeaders);
      costHeaders(actual);
      return reply.send(raw);
    }

    const actual = actualOf();
    settle(actual, res.statusCode, upstreamMs);
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
