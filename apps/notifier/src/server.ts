import { type Db, eq, orgs } from '@spend-brake/db';
import { redactingLoggerOptions, verifyAction } from '@spend-brake/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { request } from 'undici';
import { PAGE_HEADERS, confirmPage, resultPage } from './pages.js';

export interface ServerDeps {
  db: Db;
  apiUrl: string;
  actionSecret: string;
  logger?: FastifyServerOptions['logger'];
  now?: () => Date;
}

/** Action tokens are credentials for 15 minutes: keep them out of request logs. */
export const redactActionPath = (url: string) => url.replace(/\/a\/[^/?#]+/, '/a/[redacted]');

export function notifierLoggerOptions(level: string) {
  const base = redactingLoggerOptions(level);
  return {
    ...base,
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) =>
        base.serializers.req({ ...req, url: redactActionPath(req.url) }),
    },
  };
}

const DONE: Record<string, string> = {
  kill: 'Spending is stopped. Lift the kill from the dashboard when ready.',
  raise: 'The cap was raised.',
  mute: 'Alerts for this scope are muted for 24 hours.',
  reset: 'The circuit was reset.',
};

/** Confirm pages for alert action links. Confirmed actions run through the admin API. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 16 * 1024,
    // Action tokens are a few hundred characters long.
    maxParamLength: 4096,
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  app.get('/healthz', () => ({ ok: true, service: 'notifier' }));

  app.get<{ Params: { token: string } }>('/a/:token', async (req, reply) => {
    reply.headers(PAGE_HEADERS);
    const check = verifyAction(
      deps.actionSecret,
      req.params.token,
      Math.floor(now().getTime() / 1000),
    );
    if (!check.ok) {
      const msg = check.reason === 'expired' ? 'This link has expired.' : 'This link is not valid.';
      return reply.code(check.reason === 'expired' ? 410 : 400).send(resultPage(false, msg));
    }
    let loginRequired = false;
    if (check.claims.act === 'raise') {
      const [org] = await deps.db.select().from(orgs).where(eq(orgs.id, check.claims.org)).limit(1);
      loginRequired = Boolean(
        (org?.settings as { requireLoginForRaise?: boolean } | undefined)?.requireLoginForRaise,
      );
    }
    return reply.send(confirmPage(check.claims, { loginRequired }));
  });

  app.post<{ Params: { token: string }; Body: { amountUsd?: string } | undefined }>(
    '/a/:token',
    async (req, reply) => {
      reply.headers(PAGE_HEADERS);
      const usd = req.body?.amountUsd;
      const amount = usd && /^\d{1,7}$/.test(usd) ? Number(usd) * 1_000_000 : undefined;
      const res = await request(`${deps.apiUrl.replace(/\/$/, '')}/v1/actions/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: req.params.token, ...(amount ? { amount } : {}) }),
      });
      const body = (await res.body.json()) as {
        action?: string;
        message?: string;
        pendingApproval?: string;
      };
      const ok = res.statusCode === 200;
      return reply
        .code(ok ? 200 : res.statusCode)
        .send(
          resultPage(
            ok,
            !ok
              ? (body.message ?? 'Something went wrong.')
              : body.pendingApproval
                ? 'The raise is waiting for a second person to approve it in the dashboard; the cap is unchanged until then.'
                : (DONE[body.action ?? ''] ?? 'Done.'),
          ),
        );
    },
  );

  return app;
}
