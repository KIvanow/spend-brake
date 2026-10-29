import rateLimit from '@fastify/rate-limit';
import { BudgetEngine, Registry, type ValkeyClient } from '@spend-brake/budget';
import type { Db } from '@spend-brake/db';
import { type KeyWrapper, redactUrl } from '@spend-brake/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Authenticator } from './auth.js';
import type { Ctx } from './common.js';
import { sha256 } from './ids.js';
import { ApiError, Router } from './route.js';
import { adminRoutes } from './routes/admin.js';
import { budgetRoutes } from './routes/budget.js';
import { credentialRoutes } from './routes/credentials.js';
import { keyRoutes } from './routes/keys.js';
import { ledgerRoutes } from './routes/ledger.js';

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
}

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 256 * 1024,
  });
  const ctx: Ctx = {
    db: deps.db,
    valkey: deps.valkey,
    engine: new BudgetEngine(deps.valkey),
    registry: new Registry(deps.valkey),
    wrapper: deps.wrapper,
    now,
  };

  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    redis: deps.valkey,
    nameSpace: 'bk:rl:api:',
    // Per token when there is one, so one noisy client cannot starve an org's other tokens.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `t:${sha256(auth).slice(0, 32)}` : `ip:${req.ip}`;
    },
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

  const router = new Router(app, new Authenticator(deps.db, now, deps.authCacheMs));
  credentialRoutes(router, ctx);
  keyRoutes(router, ctx);
  budgetRoutes(router, ctx);
  ledgerRoutes(router, ctx);
  adminRoutes(router, ctx);

  const spec = router.document();
  app.get('/v1/openapi.json', { config: { rateLimit: false } }, () => spec);
  app.get('/healthz', { config: { rateLimit: false } }, () => ({ ok: true, service: 'api' }));
  return app;
}
