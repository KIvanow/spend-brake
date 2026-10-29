import { timingSafeEqual } from 'node:crypto';
import { orgs, sql } from '@spend-brake/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bootstrapOrg } from '../bootstrap.js';
import type { Ctx } from '../common.js';
import { ApiError, type Router, errorSchema } from '../route.js';

const body = z.object({
  setupToken: z.string().min(1).max(500),
  orgId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().min(1).max(200),
  timeZone: z.string().default('UTC'),
});

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * First run of a self-hosted install (`brake init`): with the BRAKE_SETUP_TOKEN the operator set,
 * create the org and its owner API token. Works once: after an org exists it answers 409.
 * (More than one org per install is an enterprise feature.)
 */
export function setupRoutes(
  app: FastifyInstance,
  router: Router,
  ctx: Ctx,
  setupToken: string | undefined,
): void {
  router.registry.registerPath({
    method: 'post',
    path: '/v1/setup',
    summary: 'First run: create the org and its owner token (needs BRAKE_SETUP_TOKEN)',
    tags: ['Admin'],
    request: { body: { content: { 'application/json': { schema: body } } } },
    responses: {
      201: {
        description: 'Created',
        content: {
          'application/json': { schema: z.object({ orgId: z.string(), ownerToken: z.string() }) },
        },
      },
      409: {
        description: 'Already set up',
        content: { 'application/json': { schema: errorSchema } },
      },
    },
  });

  app.post(
    '/v1/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!setupToken)
        throw new ApiError(503, 'setup_disabled', 'Set BRAKE_SETUP_TOKEN on the API first.');
      const parsed = body.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Request failed validation.');
      if (!same(parsed.data.setupToken, setupToken)) {
        throw new ApiError(401, 'unauthorized', 'Wrong setup token.');
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timeZone });
      } catch {
        throw new ApiError(400, 'invalid_request', 'Unknown time zone.');
      }
      // One transaction-level lock so two concurrent setups cannot both pass the empty check.
      const ownerToken = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
        const [existing] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
        if (existing) throw new ApiError(409, 'already_set_up', 'This install already has an org.');
        return bootstrapOrg(
          { db: tx as unknown as typeof ctx.db, registry: ctx.registry },
          { id: parsed.data.orgId, name: parsed.data.name, timeZone: parsed.data.timeZone },
        );
      });
      reply.code(201);
      return { orgId: parsed.data.orgId, ownerToken };
    },
  );
}
