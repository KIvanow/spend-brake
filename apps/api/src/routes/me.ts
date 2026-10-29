import type { Scope } from '@spend-brake/budget';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Ctx, n } from '../common.js';
import { ApiError, type Router } from '../route.js';
import { orgTimeZone } from './budget.js';

const scopeStatus = z.object({
  scope: z.string(),
  window: z.string(),
  spent: z.number(),
  held: z.number(),
  hard: z.number().nullable(),
  remaining: z.number().nullable(),
});

/**
 * What an agent may know about its own key (`brake status` inside a session): remaining budget
 * for the key, its session, parent key and agent, today and this month.
 */
export function meRoutes(app: FastifyInstance, router: Router, ctx: Ctx): void {
  router.registry.registerPath({
    method: 'get',
    path: '/v1/me',
    summary: 'Remaining budget of the calling virtual key (X-Brake-Key)',
    tags: ['Sessions'],
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
      (key.expiresAt && Date.parse(key.expiresAt) <= ctx.now().getTime())
    ) {
      throw new ApiError(401, 'invalid_key', 'Unknown, revoked or expired virtual key.');
    }
    const scopes: Scope[] = [{ kind: 'key', id: key.id }];
    if (key.sessionId) scopes.push({ kind: 'sess', id: key.sessionId });
    if (key.parentKeyId) scopes.push({ kind: 'key', id: key.parentKeyId });
    if (key.agentId) scopes.push({ kind: 'agent', id: key.agentId });
    const tz = await orgTimeZone(ctx, key.orgId);
    const status = await ctx.engine.status(key.orgId, scopes, tz, ctx.now());
    const killed = await ctx.engine.killed(key.orgId);
    const mine = [
      'org',
      `key:${key.id}`,
      ...(key.parentKeyId ? [`key:${key.parentKeyId}`] : []),
      ...(key.sessionId ? [`sess:${key.sessionId}`] : []),
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
    };
  });
}
