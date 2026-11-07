import { SESSION_ID, type Scope, capTemplatesFor } from '@spend-brake/budget';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Ctx, n } from '../common.js';
import { ApiError, type Router } from '../route.js';

const scopeStatus = z.object({
  scope: z.string(),
  window: z.string(),
  spent: z.number(),
  held: z.number(),
  hard: z.number().nullable(),
  remaining: z.number().nullable(),
});

const policyView = z.object({
  /** Providers the key may call (no credential ids). */
  providers: z.array(z.string()),
  skus: z.array(z.string()).nullable(),
  canMintSessions: z.boolean(),
  expiresAt: z.string().nullable(),
  failOpenMicros: z.number().nullable(),
  /** The org's policy for routes with no known price, for each of the key's providers. */
  unpriced: z.record(
    z.string(),
    z.object({
      policy: z.enum(['deny', 'allow-with-default-price']),
      defaultPriceMicros: z.number().nullable(),
    }),
  ),
});

/**
 * What an agent may know about its own key (`brake status` inside a session, `brake doctor`):
 * remaining budget for the key, its session, parent key and agent, today and this month, and
 * the key's own policy.
 */
export function meRoutes(app: FastifyInstance, router: Router, ctx: Ctx): void {
  router.registry.registerPath({
    method: 'get',
    path: '/v1/me',
    summary:
      'Remaining budget of the calling virtual key (X-Brake-Key), and of the session it names (X-Brake-Session)',
    tags: ['Sessions'],
    request: { headers: z.object({ 'x-brake-session': z.string().optional() }) },
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: z.object({
              keyId: z.string(),
              sessionId: z.string().nullable(),
              killed: z.boolean(),
              scopes: z.array(scopeStatus),
              policy: policyView,
            }),
          },
        },
      },
    },
  });

  app.get('/v1/me', async (req) => {
    const token = req.headers['x-brake-key'];
    const key = typeof token === 'string' ? await ctx.registry.getKeyByToken(token) : null;
    if (
      !key ||
      key.status !== 'active' ||
      (key.expiresAt && Date.parse(key.expiresAt) <= ctx.now().getTime()) ||
      (key.allowedIps !== null && !key.allowedIps.includes(req.ip))
    ) {
      throw new ApiError(401, 'invalid_key', 'Unknown, revoked or expired virtual key.');
    }
    const scopes: Scope[] = [{ kind: 'key', id: key.id }];
    if (key.sessionId) scopes.push({ kind: 'sess', id: key.sessionId });
    // A session the client names (X-Brake-Session), as the proxy charges it: only keys with a
    // session budget may name one, and its cap is that budget until the first call creates it.
    const named = req.headers['x-brake-session'];
    const namedSession =
      !key.sessionId &&
      key.sessionCapMicros !== null &&
      typeof named === 'string' &&
      SESSION_ID.test(named)
        ? named
        : null;
    if (namedSession) scopes.push({ kind: 'sess', id: namedSession });
    if (key.parentKeyId) scopes.push({ kind: 'key', id: key.parentKeyId });
    if (key.agentId) scopes.push({ kind: 'agent', id: key.agentId });
    // The org record the proxy reads holds its time zone, so windows match the proxy's.
    const [org, killed] = await Promise.all([
      ctx.registry.getOrg(key.orgId),
      ctx.engine.killed(key.orgId),
    ]);
    const status = await ctx.engine.status(
      key.orgId,
      scopes,
      org?.timeZone ?? 'UTC',
      ctx.now(),
      capTemplatesFor(key, key.sessionId ?? namedSession),
    );
    const providers = Object.keys(key.credentials).sort();
    const mine = [
      'org',
      `key:${key.id}`,
      ...(key.parentKeyId ? [`key:${key.parentKeyId}`] : []),
      ...(key.sessionId ? [`sess:${key.sessionId}`] : []),
      ...(namedSession ? [`sess:${namedSession}`] : []),
    ];
    return {
      keyId: key.id,
      sessionId: key.sessionId,
      killed: killed.some((k) => mine.includes(k)),
      scopes: status.map((s) => ({
        scope: s.scope,
        window: s.window,
        spent: Number(s.spent),
        held: Number(s.held),
        hard: n(s.hard),
        remaining: n(s.remaining),
      })),
      policy: {
        providers,
        skus: key.skus,
        canMintSessions: key.canMintSessions,
        expiresAt: key.expiresAt,
        failOpenMicros: key.failOpenMicros === null ? null : Number(key.failOpenMicros),
        unpriced: Object.fromEntries(
          providers.map((p) => {
            const o = org?.providers[p];
            return [
              p,
              {
                policy: o?.unpricedPolicy ?? 'deny',
                defaultPriceMicros:
                  o?.defaultPriceMicros === undefined ? null : Number(o.defaultPriceMicros),
              },
            ];
          }),
        ),
      },
    };
  });
}
