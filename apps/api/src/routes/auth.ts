import { and, apiTokens, eq, isNull } from '@spend-brake/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Authenticator, ROLES } from '../auth.js';
import { type Ctx, audit } from '../common.js';
import {
  type EmailSignIn,
  LOGIN_LINK_TTL_SEC,
  redeemLoginLink,
  sendSignInLinks,
} from '../login.js';
import { ApiError, type Router, errorSchema } from '../route.js';

export interface PublicInfo {
  /** Hosted sign-up is open (POST /v1/billing/signup). */
  signup?: boolean;
  /** Where apps send provider calls, for the dashboard's setup steps. */
  proxyUrl?: string;
  /** The proxy's outbound IPs: provider keys should be restricted to them. */
  egressIps?: string[];
  /** Product analytics for the dashboard (PostHog); absent, the dashboard sends none. */
  analytics?: { key: string; host: string };
}

const options = z.object({
  emailSignIn: z.boolean(),
  signup: z.boolean(),
  proxyUrl: z.string().nullable(),
  egressIps: z.array(z.string()),
  analytics: z.object({ key: z.string(), host: z.string() }).nullable(),
});
const emailBody = z.object({ email: z.string().trim().pipe(z.email().max(320)) });
const verifyBody = z.object({ code: z.string().max(100) });
const signedIn = z.object({
  token: z.string(),
  orgId: z.string(),
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
});

/** How people sign in to the dashboard: what is on, an emailed link, and spending one. */
export function authRoutes(
  app: FastifyInstance,
  router: Router,
  ctx: Ctx,
  signIn: EmailSignIn | undefined,
  info: PublicInfo,
  authenticator: Authenticator,
): void {
  const allowed = (orgId: string) => ctx.hooks.emailSignInAllowed?.(orgId) ?? Promise.resolve(true);
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

  router.registry.registerPath({
    method: 'get',
    path: '/v1/auth/options',
    summary: 'How to sign in here (public)',
    tags: ['Auth'],
    responses: { 200: { description: 'OK', content: json(options) } },
  });
  app.get('/v1/auth/options', () => ({
    emailSignIn: signIn !== undefined,
    signup: info.signup ?? false,
    proxyUrl: info.proxyUrl ?? null,
    egressIps: info.egressIps ?? [],
    analytics: info.analytics ?? null,
  }));

  router.registry.registerPath({
    method: 'post',
    path: '/v1/auth/email',
    summary: `Email a sign-in link (public; works once, for ${LOGIN_LINK_TTL_SEC / 60} minutes)`,
    tags: ['Auth'],
    request: { body: { content: json(emailBody) } },
    responses: {
      202: { description: 'Sent if the address belongs to anyone', content: json(z.object({})) },
      404: { description: 'Email sign-in is off', content: json(errorSchema) },
    },
  });
  app.post(
    '/v1/auth/email',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!signIn) throw new ApiError(404, 'not_found', 'Email sign-in is off here.');
      const body = emailBody.safeParse(req.body);
      if (!body.success) throw new ApiError(400, 'invalid_request', 'Enter an email address.');
      await sendSignInLinks({ db: ctx.db, valkey: ctx.valkey, allowed }, signIn, body.data.email);
      // The same answer whether or not the address is known.
      reply.code(202);
      return {};
    },
  );

  router.registry.registerPath({
    method: 'post',
    path: '/v1/auth/email/verify',
    summary: 'Spend an emailed sign-in link for a token (public)',
    tags: ['Auth'],
    request: { body: { content: json(verifyBody) } },
    responses: {
      200: { description: 'Signed in', content: json(signedIn) },
      400: { description: 'Link unknown, used or expired', content: json(errorSchema) },
    },
  });
  app.post(
    '/v1/auth/email/verify',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      if (!signIn) throw new ApiError(404, 'not_found', 'Email sign-in is off here.');
      const body = verifyBody.safeParse(req.body);
      const done = body.success
        ? await redeemLoginLink(
            { db: ctx.db, valkey: ctx.valkey, now: ctx.now, allowed },
            body.data.code,
          )
        : null;
      if (!done) {
        throw new ApiError(
          400,
          'link_invalid',
          'This sign-in link has expired or was already used. Ask for a new one.',
        );
      }
      const actor = {
        orgId: done.orgId,
        tokenId: done.tokenId,
        role: done.role,
        actor: `user:${done.userId}`,
        signIn: 'email' as const,
      };
      await audit(ctx, actor, 'auth.sign_in', done.userId, { via: 'email' });
      return {
        token: done.token,
        orgId: done.orgId,
        email: done.email,
        role: done.role,
        expiresAt: done.expiresAt.toISOString(),
      };
    },
  );

  router.add({
    method: 'get',
    path: '/v1/auth/session',
    role: 'viewer',
    tag: 'Auth',
    summary: 'The calling token: its org and role (the dashboard shows only what the role can do)',
    response: z.object({
      orgId: z.string(),
      role: z.enum(ROLES),
      actor: z.string(),
      signIn: z.enum(['sso', 'email']).nullable(),
    }),
    handler: ({ auth }) =>
      Promise.resolve({
        orgId: auth.orgId,
        role: auth.role,
        actor: auth.actor,
        signIn: auth.signIn,
      }),
  });

  router.add({
    method: 'delete',
    path: '/v1/auth/session',
    role: 'viewer',
    tag: 'Auth',
    summary: 'Sign out: end the calling session (tokens issued at sign-in only)',
    response: z.object({ revoked: z.boolean() }),
    handler: async ({ auth }) => {
      // Only a person's sign-in session ends here; an API token pasted into the dashboard may
      // be used elsewhere too (CI, brake init), so signing out just forgets it in the browser.
      if (auth.signIn === null) return { revoked: false };
      await ctx.db
        .update(apiTokens)
        .set({ revokedAt: ctx.now() })
        .where(
          and(
            eq(apiTokens.id, auth.tokenId),
            eq(apiTokens.orgId, auth.orgId),
            isNull(apiTokens.revokedAt),
          ),
        );
      // Refused from the next request on, not after the lookup cache expires.
      authenticator.forget();
      await audit(ctx, auth, 'auth.sign_out', auth.tokenId);
      return { revoked: true };
    },
  });
}
