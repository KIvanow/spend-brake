import {
  type KeyRecord,
  generateVirtualKey,
  hashVirtualKey,
  windowsFor,
} from '@spend-brake/budget';
import { and, caps, eq, gte, sql, virtualKeys } from '@spend-brake/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth, Authenticator } from '../auth.js';
import { atLeast } from '../auth.js';
import { type Ctx, audit, id, micros, n } from '../common.js';
import { newId, random62 } from '../ids.js';
import { ApiError, type Router, errorSchema, notFound } from '../route.js';
import { orgTimeZone } from './budget.js';
import { requireCapacity } from '../entitlements.js';

const createBody = z.object({
  /** Required with an admin token; implied when the caller authenticates with the parent key. */
  parentKeyId: id.optional(),
  /** Defaults to $5. */
  budgetMicros: micros.optional(),
  /** Defaults to $20. */
  dayBudgetMicros: micros.optional(),
  agentId: id.optional(),
  ttlSec: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600)
    .default(12 * 3600),
  name: z.string().max(200).optional(),
  /**
   * A $0 probe (`brake doctor --prove`): needs budgetMicros 0 and ttlSec of at most
   * PROBE_TTL_SEC. Its caps never change and it does not use up the plan's sessions.
   */
  probe: z.literal(true).optional(),
});

/** The longest $0 session that is a probe (`brake doctor --prove` mints 60 seconds). */
export const PROBE_TTL_SEC = 300;
/** Probes a key may mint an hour: plenty for doctor on every deploy, too few to use as sessions. */
export const PROBES_PER_HOUR = 30;

const sessionView = z
  .object({
    sessionId: z.string(),
    keyId: z.string(),
    token: z.string(),
    agentId: z.string(),
    budgetMicros: z.number(),
    dayBudgetMicros: z.number(),
    expiresAt: z.string(),
  })
  .openapi('Session');

const endView = z
  .object({
    sessionId: z.string(),
    keyId: z.string(),
    spentMicros: z.number(),
    heldMicros: z.number(),
  })
  .openapi('SessionEnd');

type Caller = { kind: 'admin'; auth: Auth } | { kind: 'key'; key: KeyRecord; auth: Auth };

/**
 * Session keys for `brake session`: a short-lived child of a parent key, whose own cap is the
 * session budget, which also spends from the parent's budget, and which seeds a daily cap for its
 * agent. Minting needs an admin token or the parent key itself with `canMintSessions`.
 */
export function sessionRoutes(
  app: FastifyInstance,
  router: Router,
  ctx: Ctx,
  auth: Authenticator,
): void {
  router.registry.registerPath({
    method: 'post',
    path: '/v1/sessions',
    summary:
      'Mint a session key (admin token, or X-Brake-Key of a parent key with canMintSessions)',
    tags: ['Sessions'],
    request: { body: { content: { 'application/json': { schema: createBody } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: sessionView } } },
      400: {
        description: 'Invalid request',
        content: { 'application/json': { schema: errorSchema } },
      },
      402: {
        description: "A failed payment, or the plan's sessions or requests are used up",
        content: { 'application/json': { schema: errorSchema } },
      },
      403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
      429: {
        description: 'Too many $0 probe sessions from this key in the last hour',
        content: { 'application/json': { schema: errorSchema } },
      },
    },
  });
  router.registry.registerPath({
    method: 'delete',
    path: '/v1/sessions/{keyId}',
    summary:
      'End a session: revoke its key and report its spend (admin, parent or the session key)',
    tags: ['Sessions'],
    request: { params: z.object({ keyId: id }) },
    responses: {
      200: { description: 'Ended', content: { 'application/json': { schema: endView } } },
    },
  });

  async function caller(req: FastifyRequest): Promise<Caller> {
    const vk = req.headers['x-brake-key'];
    if (typeof vk === 'string' && vk) {
      const key = await ctx.registry.getKeyByToken(vk);
      if (
        !key ||
        key.status !== 'active' ||
        (key.expiresAt && Date.parse(key.expiresAt) <= ctx.now().getTime()) ||
        (key.allowedIps !== null && !key.allowedIps.includes(req.ip))
      ) {
        throw new ApiError(401, 'unauthorized', 'Unknown, revoked or expired virtual key.');
      }
      return {
        kind: 'key',
        key,
        auth: {
          orgId: key.orgId,
          tokenId: key.id,
          role: 'viewer',
          actor: `key:${key.id}`,
          signIn: null,
        },
      };
    }
    const a = await auth.authenticate(req);
    if (!a) throw new ApiError(401, 'unauthorized', 'Missing or invalid API token or virtual key.');
    if (!atLeast(a.role, 'admin'))
      throw new ApiError(403, 'forbidden', 'This needs the admin role.');
    return { kind: 'admin', auth: a };
  }

  app.post('/v1/sessions', async (req, reply) => {
    const c = await caller(req);
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request failed validation.');
    const body = {
      ...parsed.data,
      budgetMicros: parsed.data.budgetMicros ?? 5_000_000n,
      dayBudgetMicros: parsed.data.dayBudgetMicros ?? 20_000_000n,
    };
    const orgId = c.auth.orgId;
    // A probe (brake doctor --prove) is asked for, never guessed from the shape: its caps, lifetime
    // and fail-open can never change, so it spends nothing and does not use up the plan's
    // sessions. A failed payment or a spent request allowance still stops it. Kept short so that
    // probes cannot stand in for sessions on routes priced at $0. Any other $0 session is an
    // ordinary session.
    const probe = body.probe === true;
    if (probe && (body.budgetMicros !== 0n || body.ttlSec > PROBE_TTL_SEC)) {
      throw new ApiError(
        400,
        'invalid_request',
        `A probe session needs budgetMicros 0 and ttlSec of at most ${PROBE_TTL_SEC}.`,
      );
    }
    await requireCapacity(ctx, orgId, probe ? 'probe' : 'session');

    let parent: KeyRecord;
    if (c.kind === 'key') {
      if (!c.key.canMintSessions) {
        throw new ApiError(403, 'forbidden', 'This key may not mint sessions (canMintSessions).');
      }
      parent = c.key;
    } else {
      if (!body.parentKeyId) throw new ApiError(400, 'invalid_request', 'Give parentKeyId.');
      const [row] = await ctx.db
        .select()
        .from(virtualKeys)
        .where(and(eq(virtualKeys.id, body.parentKeyId), eq(virtualKeys.orgId, orgId)))
        .limit(1);
      if (!row || row.status !== 'active') throw notFound('Parent key');
      parent = row.config as KeyRecord;
    }
    if (parent.sessionId)
      throw new ApiError(403, 'forbidden', 'A session key cannot mint sessions.');
    if (probe) {
      const [row] = await ctx.db
        .select({ n: sql<string>`count(*)::text` })
        .from(virtualKeys)
        .where(
          and(
            eq(virtualKeys.orgId, orgId),
            sql`${virtualKeys.config}->>'parentKeyId' = ${parent.id}`,
            gte(virtualKeys.createdAt, new Date(ctx.now().getTime() - 3600_000)),
            sql`${virtualKeys.config}->>'probe' = 'true'`,
          ),
        );
      if (Number(row?.n ?? 0) >= PROBES_PER_HOUR) {
        throw new ApiError(
          429,
          'rate_limited',
          `At most ${PROBES_PER_HOUR} $0 probe sessions an hour per key (brake doctor --prove uses one per run). Try again later.`,
        );
      }
    }

    const keyId = newId('key');
    const sessionId = `sess_${random62(16)}`;
    const token = generateVirtualKey();
    const expiresAt = new Date(
      Math.min(
        ctx.now().getTime() + body.ttlSec * 1000,
        parent.expiresAt ? Date.parse(parent.expiresAt) : Number.MAX_SAFE_INTEGER,
      ),
    );
    // A key's sessions stay its agent's: another agent id would leave that agent's caps behind.
    if (
      c.kind === 'key' &&
      parent.agentId &&
      body.agentId !== undefined &&
      body.agentId !== parent.agentId
    ) {
      throw new ApiError(
        403,
        'forbidden',
        `This key belongs to agent ${parent.agentId}: the sessions it mints are that agent's too.`,
      );
    }
    const agentId = body.agentId ?? parent.agentId ?? 'cli';
    const name = body.name ?? `session ${sessionId}`;
    const record: KeyRecord = {
      ...parent,
      id: keyId,
      name,
      status: 'active',
      expiresAt: expiresAt.toISOString(),
      agentId,
      sessionId,
      sessionCapMicros: body.budgetMicros.toString(),
      agentDayCapMicros: body.dayBudgetMicros.toString(),
      parentKeyId: parent.id,
      canMintSessions: false,
      failOpenMicros: null,
      ...(probe ? { probe: true } : {}),
    };
    // The session budget is the key's own cap: enforced even when a client never sends the
    // session header. Month window: a session's whole life.
    const version = await ctx.engine.setCap(orgId, { kind: 'key', id: keyId }, 'm', {
      hard: body.budgetMicros,
      soft: null,
    });
    await ctx.registry.putKeyByHash(hashVirtualKey(token), record);
    await ctx.db.insert(virtualKeys).values({
      id: keyId,
      orgId,
      name,
      tokenHash: hashVirtualKey(token),
      prefix: token.slice(0, 12),
      config: record,
      createdAt: ctx.now(),
      expiresAt,
    });
    await ctx.db.insert(caps).values({
      orgId,
      scope: `key:${keyId}`,
      kind: 'm',
      hardMicros: body.budgetMicros,
      softMicros: null,
      version,
      updatedAt: ctx.now(),
    });
    await audit(ctx, c.auth, 'session.create', keyId, {
      sessionId,
      parentKeyId: parent.id,
      budgetMicros: n(body.budgetMicros),
      dayBudgetMicros: n(body.dayBudgetMicros),
      agentId,
    });
    reply.code(201);
    return {
      sessionId,
      keyId,
      token,
      agentId,
      budgetMicros: n(body.budgetMicros),
      dayBudgetMicros: n(body.dayBudgetMicros),
      expiresAt: expiresAt.toISOString(),
    };
  });

  app.delete<{ Params: { keyId: string } }>('/v1/sessions/:keyId', async (req) => {
    const c = await caller(req);
    const keyId = id.safeParse(req.params.keyId);
    if (!keyId.success) throw new ApiError(400, 'invalid_request', 'Bad key id.');
    const [row] = await ctx.db
      .select()
      .from(virtualKeys)
      .where(and(eq(virtualKeys.id, keyId.data), eq(virtualKeys.orgId, c.auth.orgId)))
      .limit(1);
    const rec = row?.config as KeyRecord | undefined;
    if (!row || !rec?.sessionId) throw notFound('Session');
    if (c.kind === 'key' && c.key.id !== row.id && c.key.id !== rec.parentKeyId) {
      throw notFound('Session');
    }
    if (row.status === 'active') {
      const revoked = { ...rec, name: row.name, status: 'revoked' as const };
      await ctx.registry.putKeyByHash(row.tokenHash, revoked);
      await ctx.db
        .update(virtualKeys)
        .set({ status: 'revoked', revokedAt: ctx.now(), config: revoked })
        .where(eq(virtualKeys.id, row.id));
    }
    const tz = await orgTimeZone(ctx, c.auth.orgId);
    const month = windowsFor(ctx.now(), tz)[1].id;
    const [status] = (
      await ctx.engine.status(c.auth.orgId, [{ kind: 'key', id: row.id }], tz, ctx.now())
    ).filter((s) => s.window === month);
    await audit(ctx, c.auth, 'session.end', row.id, { sessionId: rec.sessionId });
    return {
      sessionId: rec.sessionId,
      keyId: row.id,
      spentMicros: Number(status?.spent ?? 0n),
      heldMicros: Number(status?.held ?? 0n),
    };
  });
}
