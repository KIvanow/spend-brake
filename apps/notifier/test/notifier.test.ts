import { randomBytes } from 'node:crypto';
import { buildApi } from '@spend-brake/api';
import { bootstrapOrg } from '@spend-brake/api/bootstrap';
import { BudgetEngine, Registry } from '@spend-brake/budget';
import { type Db, auditLog, createDb, eq, migrate } from '@spend-brake/db';
import {
  ALERT_QUEUE,
  type AlertJob,
  LocalKeyWrapper,
  QUEUE_PREFIX,
  signAction,
  verifyWebhook,
} from '@spend-brake/shared';
import { Queue } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedAgent, postWebhook } from '../src/deliver.js';
import { type NotifierQueues, notifierQueues } from '../src/notifier.js';
import { buildServer } from '../src/server.js';

const ACTION_SECRET = randomBytes(32).toString('hex');
const quiet = { info() {}, warn() {} };

let pg: StartedTestContainer;
let vk: StartedTestContainer;
let db: Db;
let pool: { end(): Promise<void> };
let valkey: Redis;
let queueConn: Redis;
let api: FastifyInstance;
let pages: FastifyInstance;
let queues: NotifierQueues;
let alerts: Queue<AlertJob>;
let engine: BudgetEngine;
let registry: Registry;
const mails: {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: string }[];
}[] = [];

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
const receivers: { app: FastifyInstance; url: string; got: Received[]; fail: number }[] = [];

async function receiver(fail = 0) {
  const r = { app: Fastify(), url: '', got: [] as Received[], fail };
  r.app.removeAllContentTypeParsers();
  r.app.addContentTypeParser('*', { parseAs: 'string' }, (_q, b, done) => done(null, b));
  r.app.post('/hook/:secretPath', (req, reply) => {
    r.got.push({ headers: req.headers, body: req.body as string });
    if (r.fail > 0) {
      r.fail--;
      return reply.code(500).send('nope');
    }
    return reply.send('ok');
  });
  r.url = `${await r.app.listen({ port: 0, host: '127.0.0.1' })}/hook/T0P-SECRET-PATH`;
  receivers.push(r);
  return r;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

beforeAll(async () => {
  [pg, vk] = await Promise.all([
    new GenericContainer('postgres:16')
      .withEnvironment({ POSTGRES_PASSWORD: 'p', POSTGRES_USER: 'brake', POSTGRES_DB: 'brake' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  ({ db, pool } = createDb(`postgres://brake:p@${pg.getHost()}:${pg.getMappedPort(5432)}/brake`));
  await migrate(db);
  const url = `redis://${vk.getHost()}:${vk.getMappedPort(6379)}`;
  valkey = new Redis(url);
  queueConn = new Redis(url, { maxRetriesPerRequest: null });
  engine = new BudgetEngine(valkey);
  registry = new Registry(valkey);
  const wrapper = new LocalKeyWrapper(randomBytes(32).toString('base64'));

  api = await buildApi({
    db,
    valkey,
    wrapper,
    actionSecret: ACTION_SECRET,
    authCacheMs: 0,
    rateLimitPerMinute: 100_000,
  });
  const apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
  pages = buildServer({ db, apiUrl, actionSecret: ACTION_SECRET });
  await pages.ready();

  const transport = createTransport({ jsonTransport: true });
  const send = transport.sendMail.bind(transport);
  transport.sendMail = (m: {
    to: string;
    subject: string;
    text: string;
    attachments?: { filename: string; content: string }[];
  }) => {
    mails.push({ to: m.to, subject: m.subject, text: m.text, attachments: m.attachments ?? [] });
    return send(m);
  };

  queues = notifierQueues(queueConn, 0.001);
  queues.start({
    db,
    valkey,
    wrapper,
    dispatcher: guardedAgent(true),
    links: {
      publicUrl: 'https://brake.example.com',
      actionSecret: ACTION_SECRET,
      ttlSec: 900,
      maxCustomMicros: 100_000_000n,
      now: () => new Date(),
    },
    mail: { transport, from: 'alerts@test', operator: 'ops@test' },
    log: quiet,
  });
  alerts = new Queue<AlertJob>(ALERT_QUEUE, { connection: queueConn, prefix: QUEUE_PREFIX });
});

afterAll(async () => {
  await queues.close();
  await alerts.close();
  await pages.close();
  await api.close();
  for (const r of receivers) await r.app.close();
  await valkey.quit();
  await queueConn.quit();
  await pool.end();
  await Promise.all([pg.stop(), vk.stop()]);
});

let n = 0;
async function org() {
  const id = `org${++n}`;
  const owner = await bootstrapOrg({ db, registry }, { id, name: id });
  return { id, owner };
}
const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  api.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

async function webhook(token: string, url: string, preset = 'raw', events: string[] = []) {
  const res = await call(token, 'POST', '/v1/webhooks', { name: preset, url, preset, events });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; secret: string }>();
}

const alert = (data: AlertJob) =>
  alerts.add(data.type, data, { jobId: `t-${randomBytes(6).toString('hex')}` });
const tokenOf = (url: string) => url.split('/a/')[1]!;

describe('webhook delivery', () => {
  it('delivers signed alerts to every subscribed webhook, in each preset', async () => {
    const o = await org();
    const raw = await receiver();
    const slack = await receiver();
    const loopsOnly = await receiver();
    const hRaw = await webhook(o.owner, raw.url, 'raw');
    await webhook(o.owner, slack.url, 'slack');
    await webhook(o.owner, loopsOnly.url, 'raw', ['loop']);

    await alert({
      type: 'threshold',
      orgId: o.id,
      scope: 'key:k1',
      window: 'd:20261029',
      mark: '80',
    });
    await until(() => raw.got.length === 1 && slack.got.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(loopsOnly.got).toHaveLength(0);

    const got = raw.got[0]!;
    expect(
      verifyWebhook(
        hRaw.secret,
        {
          signature: got.headers['x-brake-signature'] as string,
          timestamp: got.headers['x-brake-timestamp'] as string,
        },
        got.body,
      ),
    ).toBe(true);
    const payload = JSON.parse(got.body) as {
      type: string;
      orgId: string;
      actions: { id: string; url: string }[];
    };
    expect(payload).toMatchObject({ type: 'threshold', orgId: o.id });
    expect(payload.actions.map((a) => a.id)).toEqual([
      'kill',
      'raise_25',
      'raise_50',
      'raise_custom',
      'mute',
    ]);
    expect(JSON.parse(slack.got[0]!.body)).toHaveProperty('blocks');

    const log = await call(o.owner, 'GET', `/v1/webhooks/${hRaw.id}/deliveries`);
    expect(log.json<{ items: { ok: boolean; attempt: number }[] }>().items).toEqual([
      expect.objectContaining({ ok: true, attempt: 1, type: 'threshold' }),
    ]);
    // The webhook URL is a credential: never shown back.
    const list = await call(o.owner, 'GET', '/v1/webhooks');
    expect(list.body).not.toContain('T0P-SECRET-PATH');
  });

  it('retries failed deliveries and logs every attempt', async () => {
    const o = await org();
    const flaky = await receiver(2);
    const h = await webhook(o.owner, flaky.url);
    await alert({ type: 'loop', orgId: o.id, keyId: 'k1' });
    await until(() => flaky.got.length === 3);
    await until(
      async () =>
        (await call(o.owner, 'GET', `/v1/webhooks/${h.id}/deliveries`)).json<{ items: unknown[] }>()
          .items.length === 3,
    );
    const log = await call(o.owner, 'GET', `/v1/webhooks/${h.id}/deliveries`);
    expect(
      log
        .json<{ items: { ok: boolean; httpStatus: number }[] }>()
        .items.map((d) => [d.ok, d.httpStatus]),
    ).toEqual([
      [true, 200],
      [false, 500],
      [false, 500],
    ]);
  });

  it('keeps webhook URLs out of the delivery log', async () => {
    const o = await org();
    const h = await webhook(o.owner, 'http://127.0.0.1:1/hook/T0P-SECRET-PATH');
    await alert({ type: 'loop', orgId: o.id, keyId: 'k1' });
    await until(
      async () =>
        (await call(o.owner, 'GET', `/v1/webhooks/${h.id}/deliveries`)).json<{ items: unknown[] }>()
          .items.length >= 1,
    );
    const log = await call(o.owner, 'GET', `/v1/webhooks/${h.id}/deliveries`);
    expect(log.body).toContain('ECONNREFUSED');
    expect(log.body).not.toContain('T0P-SECRET-PATH');
  });

  it('refuses private addresses unless allowed', async () => {
    const res = await postWebhook(
      'http://127.0.0.1:9/x',
      's',
      {},
      { dispatcher: guardedAgent(false) },
    );
    expect(res).toMatchObject({ ok: false, status: null });
    expect(res.error).toContain('private address');
  });
});

describe('fallbacks and mutes', () => {
  it('emails the org when it has no webhook', async () => {
    const o = await org();
    await call(o.owner, 'PUT', '/v1/org', { alertEmail: 'owner@example.com' });
    await alert({
      type: 'blocked',
      orgId: o.id,
      scope: 'org',
      window: 'd:20261029',
      worstMicros: '32000',
    });
    await until(() => mails.some((m) => m.to === 'owner@example.com'));
    const m = mails.find((x) => x.to === 'owner@example.com')!;
    expect(m.subject).toContain('Request blocked');
    expect(m.text).toContain('Raise +$25: https://brake.example.com/a/');
  });

  it('emails a license to the billing contact as an attachment, never to webhooks', async () => {
    const o = await org();
    const r = await receiver();
    await webhook(o.owner, r.url);
    await alert({
      type: 'license_issued',
      orgId: o.id,
      email: 'billing@example.com',
      edition: 'business',
      expiresAt: '2026-11-30T12:00:00.000Z',
      license: '{"format":"spend-brake-license/1","payload":"e30","signature":"AA"}\n',
    });
    await until(() => mails.some((m) => m.to === 'billing@example.com'));
    const m = mails.find((x) => x.to === 'billing@example.com')!;
    expect(m.subject).toBe('[Spend Brake] Your Spend Brake business license');
    expect(m.attachments).toMatchObject([
      {
        filename: `${o.id}.license`,
        content: '{"format":"spend-brake-license/1","payload":"e30","signature":"AA"}\n',
      },
    ]);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toHaveLength(0);
  });

  it('emails sign-in links to that person only: never webhooks or the operator', async () => {
    const o = await org();
    const r = await receiver();
    await webhook(o.owner, r.url);
    await alert({
      type: 'login_link',
      orgId: null,
      email: 'pat@example.com',
      purpose: 'invite',
      links: [{ orgId: o.id, orgName: 'Acme', url: 'https://app.example.com/#login=abc' }],
    });
    await until(() => mails.some((m) => m.to === 'pat@example.com'));
    const m = mails.find((x) => x.to === 'pat@example.com')!;
    expect(m.subject).toBe("[Spend Brake] You're invited to Acme on Spend Brake");
    expect(m.text).toContain('Sign in: https://app.example.com/#login=abc');
    expect(m.text).toContain('works once, for 15 minutes');
    expect(m.text).not.toContain('Action links');
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toHaveLength(0);
    expect(mails.some((x) => x.to === 'ops@test' && x.text.includes('#login='))).toBe(false);
  });

  it('sends operator alerts to the operator email', async () => {
    await alert({ type: 'catalog_drift', orgId: null, url: 'https://developers.google.com/x' });
    await until(() => mails.some((m) => m.to === 'ops@test'));
  });

  it('drops alerts for a muted scope', async () => {
    const o = await org();
    const r = await receiver();
    await webhook(o.owner, r.url);
    await valkey.set(`bk:{o:${o.id}}:mute:key:k1`, '1', 'EX', 60);
    await alert({
      type: 'threshold',
      orgId: o.id,
      scope: 'key:k1',
      window: 'd:20261029',
      mark: '50',
    });
    await alert({
      type: 'threshold',
      orgId: o.id,
      scope: 'key:k2',
      window: 'd:20261029',
      mark: '50',
    });
    await until(() => r.got.length === 1);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toHaveLength(1);
    expect(JSON.parse(r.got[0]!.body)).toMatchObject({ data: { scope: 'key:k2' } });
  });
});

describe('action links', () => {
  const link = (orgId: string, claims: Record<string, unknown>, expIn = 900) =>
    signAction(ACTION_SECRET, {
      org: orgId,
      exp: Math.floor(Date.now() / 1000) + expIn,
      ...claims,
    } as Parameters<typeof signAction>[1]);

  it('GET only shows a confirm page; POST acts once and is audited', async () => {
    const o = await org();
    const t = link(o.id, { act: 'kill', target: 'key:k1', alert: 'a1' });
    const page = await pages.inject(`/a/${t}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('Stop all spending for key:k1?');
    expect(page.body).toContain('<form method="post">');
    expect(await engine.killed(o.id)).toEqual([]);

    const done = await pages.inject({ method: 'POST', url: `/a/${t}` });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Spending is stopped');
    expect(await engine.killed(o.id)).toEqual(['key:k1']);
    const again = await pages.inject({ method: 'POST', url: `/a/${t}` });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('already used');

    const audit = await db.select().from(auditLog).where(eq(auditLog.orgId, o.id));
    expect(audit.find((a) => a.action === 'kill')).toMatchObject({
      target: 'key:k1',
      actor: expect.stringMatching(/^link:/) as string,
      data: { alert: 'a1', via: 'action_link' },
    });
  });

  it('rejects tampered, expired and foreign links', async () => {
    const o = await org();
    const t = link(o.id, { act: 'kill', target: 'org' });
    const [p, s] = t.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), target: 'key:x' }),
    ).toString('base64url');
    expect((await pages.inject(`/a/${forged}.${s}`)).statusCode).toBe(400);
    expect((await pages.inject({ method: 'POST', url: `/a/${forged}.${s}` })).statusCode).toBe(400);
    const expired = link(o.id, { act: 'kill', target: 'org' }, -1);
    expect((await pages.inject(`/a/${expired}`)).statusCode).toBe(410);
    expect((await pages.inject({ method: 'POST', url: `/a/${expired}` })).statusCode).toBe(410);
    const other = signAction('y'.repeat(64), {
      org: o.id,
      act: 'kill',
      target: 'org',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect((await pages.inject({ method: 'POST', url: `/a/${other}` })).statusCode).toBe(400);
    expect(await engine.killed(o.id)).toEqual([]);
  });

  it('a link only ever acts on the org it was issued for', async () => {
    const a = await org();
    const b = await org();
    const t = link(a.id, { act: 'kill', target: 'org' });
    expect((await pages.inject({ method: 'POST', url: `/a/${t}` })).statusCode).toBe(200);
    expect(await engine.killed(a.id)).toEqual(['org']);
    expect(await engine.killed(b.id)).toEqual([]);
    // Single use is per org and link: a fresh link for b still works.
    expect(
      (
        await pages.inject({
          method: 'POST',
          url: `/a/${link(b.id, { act: 'kill', target: 'key:x' })}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await engine.killed(b.id)).toEqual(['key:x']);
  });

  it('raises a cap by a fixed or custom amount within the link limit', async () => {
    const o = await org();
    await call(o.owner, 'PUT', '/v1/caps/key:k1', { day: { hard: 10_000_000 } });
    const fixed = link(o.id, { act: 'raise', target: 'key:k1', kind: 'd', amount: '25000000' });
    expect((await pages.inject({ method: 'POST', url: `/a/${fixed}` })).statusCode).toBe(200);
    expect((await engine.getCap(o.id, { kind: 'key', id: 'k1' }, 'd'))?.hard).toBe(35_000_000n);

    const custom = link(o.id, {
      act: 'raise',
      target: 'key:k1',
      kind: 'd',
      amount: 'custom',
      max: '100000000',
    });
    const page = await pages.inject(`/a/${custom}`);
    expect(page.body).toContain('name="amountUsd"');
    const tooMuch = await pages.inject({
      method: 'POST',
      url: `/a/${custom}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'amountUsd=500',
    });
    expect(tooMuch.statusCode).toBe(400);
    const ok = await pages.inject({
      method: 'POST',
      url: `/a/${link(o.id, { act: 'raise', target: 'key:k1', kind: 'd', amount: 'custom', max: '100000000' })}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'amountUsd=30',
    });
    expect(ok.statusCode).toBe(200);
    expect((await engine.getCap(o.id, { kind: 'key', id: 'k1' }, 'd'))?.hard).toBe(65_000_000n);
    const caps = await call(o.owner, 'GET', '/v1/caps');
    expect(caps.json<{ items: { hard: number }[] }>().items[0]!.hard).toBe(65_000_000);
  });

  it('refuses raise links when the org requires the dashboard', async () => {
    const o = await org();
    await call(o.owner, 'PUT', '/v1/caps/org', { day: { hard: 1_000_000 } });
    await call(o.owner, 'PUT', '/v1/org', { requireLoginForRaise: true });
    const t = link(o.id, { act: 'raise', target: 'org', kind: 'd', amount: '25000000' });
    const page = await pages.inject(`/a/${t}`);
    expect(page.body).toContain('dashboard only');
    expect(page.body).not.toContain('<form');
    expect((await pages.inject({ method: 'POST', url: `/a/${t}` })).statusCode).toBe(403);
    expect((await engine.getCap(o.id, { kind: 'org' }, 'd'))?.hard).toBe(1_000_000n);
  });

  it('mutes a scope and resets a loop circuit', async () => {
    const o = await org();
    expect(
      (
        await pages.inject({
          method: 'POST',
          url: `/a/${link(o.id, { act: 'mute', target: 'key:k1' })}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await valkey.ttl(`bk:{o:${o.id}}:mute:key:k1`)).toBeGreaterThan(86_000);
    await valkey.set(`bk:{o:${o.id}}:circuit:key:k1`, '1', 'EX', 600);
    expect(
      (
        await pages.inject({
          method: 'POST',
          url: `/a/${link(o.id, { act: 'reset', target: 'k1' })}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await valkey.exists(`bk:{o:${o.id}}:circuit:key:k1`)).toBe(0);
  });

  it('escapes link data in the page', async () => {
    const o = await org();
    const page = await pages.inject(
      `/a/${link(o.id, { act: 'mute', target: '<script>alert(1)</script>' })}`,
    );
    expect(page.body).not.toContain('<script>alert(1)');
    expect(page.body).toContain('&lt;script&gt;');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('links from a real alert work end to end', async () => {
    const o = await org();
    const r = await receiver();
    await webhook(o.owner, r.url);
    await alert({ type: 'loop', orgId: o.id, keyId: 'k7' });
    await until(() => r.got.length === 1);
    const kill = (JSON.parse(r.got[0]!.body) as { actions: { id: string; url: string }[] })
      .actions[0]!;
    expect(
      (await pages.inject({ method: 'POST', url: `/a/${tokenOf(kill.url)}` })).statusCode,
    ).toBe(200);
    expect(await engine.killed(o.id)).toEqual(['key:k7']);
  });
});
