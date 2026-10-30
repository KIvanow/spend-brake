import rateLimit from '@fastify/rate-limit';
import { BudgetEngine, Registry, type ValkeyClient } from '@spend-brake/budget';
import type { Db } from '@spend-brake/db';
import { type KeyWrapper, redactUrl } from '@spend-brake/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Authenticator } from './auth.js';
import type { ApiHooks, Ctx } from './common.js';
import type { EmailSignIn } from './login.js';
import { ApiError, Router } from './route.js';
import { actionRoutes } from './routes/actions.js';
import { adminRoutes } from './routes/admin.js';
import { type PublicInfo, authRoutes } from './routes/auth.js';
import { budgetRoutes } from './routes/budget.js';
import { credentialRoutes } from './routes/credentials.js';
import { keyRoutes } from './routes/keys.js';
import { ledgerRoutes } from './routes/ledger.js';
import type { KeyCheck } from './google-check.js';
import { estimateRoutes } from './routes/estimates.js';
import { meRoutes } from './routes/me.js';
import { sessionRoutes } from './routes/sessions.js';
import { setupRoutes } from './routes/setup.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface ApiDeps {
  db: Db;
  valkey: ValkeyClient;
  /** Master-key wrapper for provider credentials; null disables adding credentials. */
  wrapper: KeyWrapper | null;
  logger?: FastifyServerOptions['logger'];
  rateLimitPerMinute?: number;
  trustProxy?: boolean;
  now?: () => Date;
  /** How long a token lookup is cached; revocation takes effect after this. */
  authCacheMs?: number;
  /** HMAC secret for alert action links (shared with the notifier). */
  actionSecret?: string;
  /** First-run token for POST /v1/setup. */
  setupToken?: string;
  /** Check new Google keys' restrictions (calls Google); off unless given. */
  checkGoogleKey?: (key: string) => Promise<KeyCheck>;
  /** People sign in with an emailed link (needs the notifier's email settings); off if absent. */
  emailSignIn?: EmailSignIn;
  /** What the dashboard may know before sign-in (GET /v1/auth/options). */
  publicInfo?: PublicInfo;
  /** Add routes and hooks after the core ones (separately licensed features plug in here). */
  extensions?: ApiExtension[];
}

export interface ApiHost {
  app: FastifyInstance;
  router: Router;
  ctx: Ctx;
  authenticator: Authenticator;
}

export type ApiExtension = (host: ApiHost) => void | Promise<void>;

export function apiContext(deps: ApiDeps, hooks: ApiHooks = {}): Ctx {
  return {
    hooks,
    db: deps.db,
    valkey: deps.valkey,
    engine: new BudgetEngine(deps.valkey),
    registry: new Registry(deps.valkey),
    wrapper: deps.wrapper,
    now: deps.now ?? (() => new Date()),
    ...(deps.checkGoogleKey ? { checkGoogleKey: deps.checkGoogleKey } : {}),
  };
}

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 256 * 1024,
  });
  const ctx = apiContext({ ...deps, now });

  await app.register(rateLimit, {
    // Several people may share one IP; the per-token limit is the tighter one.
    max: (deps.rateLimitPerMinute ?? 600) * 4,
    timeWindow: '1 minute',
    redis: deps.valkey,
    nameSpace: 'bk:rl:api:',
    // Per client IP before authentication: keying on an unverified header would let each
    // request pick a fresh bucket. Valid tokens get their own limit after auth (Router).
    keyGenerator: (req) => `ip:${req.ip}`,
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests; retry in ${Math.ceil(c.ttl / 1000)} s.`,
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const issues = (err as ApiError & { issues?: unknown[] }).issues;
      return reply
        .code(err.status)
        .send({ error: err.code, message: err.message, ...(issues ? { issues } : {}) });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.code(429).send(err);
    if (e.statusCode && e.statusCode < 500) {
      // Fastify's own client errors (bad JSON, body too large): never echo the body back.
      return reply
        .code(e.statusCode)
        .send({ error: 'invalid_request', message: 'Malformed request.' });
    }
    req.log.error({ err: { message: redactUrl(e.message ?? ''), code: e.code } }, 'api error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error.' });
  });

  const perToken = deps.rateLimitPerMinute ?? 600;
  const authenticator = new Authenticator(deps.db, now, deps.authCacheMs);
  const router = new Router(
    app,
    authenticator,
    async (auth) => {
      const key = `bk:rl:api:tok:${auth.tokenId}:${Math.floor(now().getTime() / 60_000)}`;
      const n = await deps.valkey.incr(key);
      if (n === 1) await deps.valkey.expire(key, 120);
      return n <= perToken;
    },
    ctx.hooks,
  );
  credentialRoutes(router, ctx);
  keyRoutes(router, ctx);
  budgetRoutes(router, ctx);
  ledgerRoutes(router, ctx);
  adminRoutes(router, ctx);
  webhookRoutes(router, ctx);
  actionRoutes(app, router, ctx, deps.actionSecret);
  sessionRoutes(app, router, ctx, authenticator);
  setupRoutes(app, router, ctx, deps.setupToken);
  meRoutes(app, router, ctx);
  estimateRoutes(router, ctx);
  authRoutes(app, router, ctx, deps.emailSignIn, deps.publicInfo ?? {});
  userRoutes(router, ctx, deps.emailSignIn);
  for (const extend of deps.extensions ?? []) await extend({ app, router, ctx, authenticator });

  const spec = router.document();
  app.get('/v1/openapi.json', { config: { rateLimit: false } }, () => spec);
  app.get('/healthz', { config: { rateLimit: false } }, () => ({ ok: true, service: 'api' }));
  return app;
}
