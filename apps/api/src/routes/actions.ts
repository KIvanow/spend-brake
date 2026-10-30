import { MAX_MICROS } from '@spend-brake/budget';
import { type ActionClaims, verifyAction } from '@spend-brake/shared';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { type Ctx, audit, n, toKillTarget, toScope, writeCap } from '../common.js';
import { ApiError, type Router, errorSchema } from '../route.js';
import type { FastifyInstance } from 'fastify';
import { loadOrg } from './admin.js';

export const MUTE_SEC = 24 * 3600;

const body = z.object({
  token: z.string().min(10).max(4096),
  /** Custom raise amount in micros (only for raise links with amount 'custom'). */
  amount: z.coerce.number().int().positive().optional(),
});

/**
 * Executes an alert action link. The signed, single-use, 15-minute token is the credential: it
 * names the org, the action and its target, so whoever holds the link can do exactly that once.
 * Runs through the same engine and audit log as the dashboard; the actor is `link:<jti>`.
 */
export function actionRoutes(
  app: FastifyInstance,
  router: Router,
  ctx: Ctx,
  secret: string | undefined,
): void {
  router.registry.registerPath({
    method: 'post',
    path: '/v1/actions/execute',
    summary:
      'Run an alert action link (kill, raise, mute, reset circuit); the token is the credential',
    tags: ['Alerts'],
    request: { body: { content: { 'application/json': { schema: body } } } },
    responses: {
      200: {
        description: 'Done',
        content: {
          'application/json': {
            schema: z
              .object({ ok: z.literal(true), action: z.string(), target: z.string() })
              .passthrough(),
          },
        },
      },
      409: {
        description: 'Link already used',
        content: { 'application/json': { schema: errorSchema } },
      },
      410: {
        description: 'Link expired',
        content: { 'application/json': { schema: errorSchema } },
      },
    },
  });

  app.post('/v1/actions/execute', async (req, reply) => {
    if (!secret) throw new ApiError(503, 'actions_disabled', 'Set BRAKE_ACTION_SECRET first.');
    const parsed = body.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request failed validation.');
    const check = verifyAction(secret, parsed.data.token, Math.floor(ctx.now().getTime() / 1000));
    if (!check.ok) {
      throw new ApiError(
        check.reason === 'expired' ? 410 : 400,
        `link_${check.reason}`,
        linkMessage(check.reason),
      );
    }
    const c = check.claims;
    const org = await loadOrg(ctx, c.org);
    const settings = org.settings as { requireLoginForRaise?: boolean };
    if (c.act === 'raise' && settings.requireLoginForRaise) {
      throw new ApiError(403, 'login_required', 'This org raises caps from the dashboard only.');
    }
    const amount = raiseAmount(c, parsed.data.amount);

    // Single use: the first request to claim the id wins; replays and link previews that POST
    // after it get 409.
    const ttl = Math.max(60, c.exp - Math.floor(ctx.now().getTime() / 1000) + 60);
    const claimed = await ctx.valkey.set(`bk:{o:${c.org}}:action:${c.jti}`, '1', 'EX', ttl, 'NX');
    if (claimed !== 'OK') throw new ApiError(409, 'link_used', 'This link was already used.');

    const auth: Auth = {
      orgId: c.org,
      tokenId: c.jti,
      role: 'admin',
      actor: `link:${c.jti}`,
      signIn: null,
    };
    const result = await execute(ctx, auth, c, amount);
    reply.code(200);
    return { ok: true, action: c.act, target: c.target, ...result };
  });
}

function linkMessage(reason: string): string {
  return reason === 'expired'
    ? 'This link has expired; open the dashboard instead.'
    : 'This link is not valid.';
}

function raiseAmount(c: ActionClaims, custom: number | undefined): bigint | null {
  if (c.act !== 'raise') return null;
  if (c.amount === 'custom') {
    if (custom === undefined) throw new ApiError(400, 'invalid_request', 'Give an amount.');
    if (c.max && BigInt(custom) > BigInt(c.max)) {
      throw new ApiError(400, 'invalid_request', 'Amount is above what this link allows.');
    }
    return BigInt(custom);
  }
  if (!c.amount || !/^\d+$/.test(c.amount)) throw new ApiError(400, 'link_malformed', 'Bad link.');
  return BigInt(c.amount);
}

async function execute(
  ctx: Ctx,
  auth: Auth,
  c: ActionClaims,
  amount: bigint | null,
): Promise<Record<string, unknown>> {
  const data = { alert: c.alert ?? null, via: 'action_link' };
  switch (c.act) {
    case 'kill':
      await ctx.engine.kill(c.org, toKillTarget(c.target));
      await audit(ctx, auth, 'kill', c.target, data, 'alert action link');
      return {};
    case 'reset':
      await ctx.engine.resetCircuit(c.org, c.target);
      await audit(ctx, auth, 'circuit.reset', `key:${c.target}`, data);
      return {};
    case 'mute':
      await ctx.valkey.set(`bk:{o:${c.org}}:mute:${c.target}`, '1', 'EX', MUTE_SEC);
      await audit(ctx, auth, 'alerts.mute', c.target, { ...data, seconds: MUTE_SEC });
      return { mutedForSec: MUTE_SEC };
    case 'raise': {
      const kind = c.kind ?? 'd';
      const scope = toScope(c.target);
      const current = await ctx.engine.getCap(c.org, scope, kind);
      if (current?.hard === null || current?.hard === undefined) {
        throw new ApiError(409, 'no_cap', 'This scope has no hard cap to raise.');
      }
      const hard = current.hard + amount!;
      if (hard > MAX_MICROS) {
        throw new ApiError(400, 'invalid_request', 'The raised cap would be too large.');
      }
      const approvalId = await ctx.hooks.holdCapRaise?.({
        auth,
        orgId: c.org,
        scope: c.target,
        kind,
        from: { hard: current.hard, soft: current.soft },
        to: { hard, soft: current.soft },
        via: 'action_link',
      });
      if (approvalId) return { kind, pendingApproval: approvalId };
      const version = await writeCap(ctx, c.org, c.target, kind, { hard, soft: current.soft });
      await audit(ctx, auth, 'cap.raise', `${c.target}:${kind}`, {
        ...data,
        by: n(amount),
        from: n(current.hard),
        to: n(hard),
        version,
      });
      return { kind, hard: n(hard) };
    }
  }
}
