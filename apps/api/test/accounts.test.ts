import { randomBytes } from 'node:crypto';
import { auditLog, eq } from '@spend-brake/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Authenticator } from '../src/auth.js';
import { createOrg } from '../src/bootstrap.js';
import { type LoginMail, allowLinkTo } from '../src/login.js';
import { buildApi } from '../src/server.js';
import { type Env, bearer, startEnv } from './harness.js';

let env: Env;
let app: FastifyInstance;
let sent: LoginMail[] = [];
let ssoOrgs = new Set<string>();

beforeAll(async () => {
  env = await startEnv();
  app = await buildApi({
    db: env.db,
    valkey: env.valkey,
    wrapper: null,
    rateLimitPerMinute: 100_000,
    authCacheMs: 0,
    emailSignIn: {
      dashboardUrl: 'https://app.example.com/',
      mailer: { send: (m) => Promise.resolve(void sent.push(m)) },
    },
    publicInfo: {
      signup: true,
      proxyUrl: 'https://proxy.example.com',
      egressIps: ['203.0.113.7'],
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await env.stop();
});

beforeEach(async () => {
  sent = [];
  ssoOrgs = new Set();
  await env.valkey.flushall();
});

let n = 0;
async function orgWithOwner(email: string) {
  const id = `acct${++n}_${randomBytes(3).toString('hex')}`;
  const { ownerId } = await createOrg(
    { db: env.db, registry: env.registry },
    { id, name: `Org ${id}` },
    { email },
  );
  return { id, ownerId: ownerId! };
}

const codeOf = (url: string) => /#login=([A-Za-z0-9_-]+)$/.exec(url)![1]!;

async function signIn(email: string) {
  sent = [];
  const res = await app.inject({ method: 'POST', url: '/v1/auth/email', payload: { email } });
  expect(res.statusCode).toBe(202);
  const mail = sent[0]!;
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/auth/email/verify',
    payload: { code: codeOf(mail.links[0]!.url) },
  });
  expect(verify.statusCode).toBe(200);
  return verify.json<{ token: string; orgId: string; role: string; expiresAt: string }>();
}

describe('sign-in options', () => {
  it('say what is on, before anyone signs in', async () => {
    const res = await app.inject('/v1/auth/options');
    expect(res.json()).toEqual({
      emailSignIn: true,
      signup: true,
      proxyUrl: 'https://proxy.example.com',
      egressIps: ['203.0.113.7'],
    });
    const off = await buildApi({ db: env.db, valkey: env.valkey, wrapper: null });
    expect((await off.inject('/v1/auth/options')).json()).toEqual({
      emailSignIn: false,
      signup: false,
      proxyUrl: null,
      egressIps: [],
    });
    expect(
      (await off.inject({ method: 'POST', url: '/v1/auth/email', payload: { email: 'a@b.co' } }))
        .statusCode,
    ).toBe(404);
    await off.close();
  });
});

describe('email sign-in', () => {
  it('emails a one-time link that signs the person in as themselves', async () => {
    const org = await orgWithOwner('ana@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: '  Ana@Example.COM ' },
    });
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ email: 'ana@example.com', purpose: 'sign_in' });
    const url = sent[0]!.links[0]!.url;
    expect(url).toMatch(/^https:\/\/app\.example\.com\/#login=[A-Za-z0-9_-]{43}$/);

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { code: codeOf(url) },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json<{ token: string; orgId: string; role: string; expiresAt: string }>();
    expect(body).toMatchObject({ orgId: org.id, role: 'owner', email: 'ana@example.com' });
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect((await app.inject({ url: '/v1/org', headers: bearer(body.token) })).statusCode).toBe(
      200,
    );

    // The link works once.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { code: codeOf(url) },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: 'link_invalid' });

    const [entry] = await env.db.select().from(auditLog).where(eq(auditLog.orgId, org.id));
    expect(entry).toMatchObject({ action: 'auth.sign_in', actor: `user:${org.ownerId}` });
  });

  it('answers the same for an unknown address, and sends nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: 'nobody@example.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({});
    expect(sent).toHaveLength(0);
  });

  it('lists every org the address belongs to in one email', async () => {
    const a = await orgWithOwner('multi@example.com');
    const b = await orgWithOwner('multi@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: 'multi@example.com' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.links.map((l) => l.orgId).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses made-up and malformed codes', async () => {
    for (const code of ['x', 'A'.repeat(43), '../../etc']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: { code },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('sends at most five links an hour to one address', async () => {
    for (let i = 0; i < 5; i++) expect(await allowLinkTo(env.valkey, 'X@example.com')).toBe(true);
    expect(await allowLinkTo(env.valkey, 'x@example.com ')).toBe(false);
    expect(await allowLinkTo(env.valkey, 'y@example.com')).toBe(true);
  });

  it('marks the token as an email sign-in, which is not single sign-on', async () => {
    await orgWithOwner('mark@example.com');
    const { token } = await signIn('mark@example.com');
    const auth = await new Authenticator(env.db, () => new Date(), 0).authenticate({
      headers: { authorization: `Bearer ${token}` },
    } as never);
    expect(auth).toMatchObject({ role: 'owner', signIn: 'email' });
    expect(auth!.actor).toMatch(/^user:usr_/);
  });

  it('stops working for orgs that require single sign-on', async () => {
    const org = await orgWithOwner('sso@example.com');
    const gated = await buildApi({
      db: env.db,
      valkey: env.valkey,
      wrapper: null,
      emailSignIn: {
        dashboardUrl: 'https://app.example.com',
        mailer: { send: (m) => Promise.resolve(void sent.push(m)) },
      },
      extensions: [
        ({ ctx }) => {
          ctx.hooks.emailSignInAllowed = (orgId) => Promise.resolve(!ssoOrgs.has(orgId));
        },
      ],
    });
    // A link sent before SSO was turned on no longer works after.
    await gated.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: 'sso@example.com' },
    });
    expect(sent).toHaveLength(1);
    ssoOrgs.add(org.id);
    const verify = await gated.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { code: codeOf(sent[0]!.links[0]!.url) },
    });
    expect(verify.statusCode).toBe(400);
    sent = [];
    await gated.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: 'sso@example.com' },
    });
    expect(sent).toHaveLength(0);
    await gated.close();
  });
});

describe('team', () => {
  it('invites a person, who signs in with the emailed link at their role', async () => {
    const org = await orgWithOwner('owner@example.com');
    const { token: owner } = await signIn('owner@example.com');
    sent = [];
    const invite = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(owner),
      payload: { email: 'Viewer@Example.com', role: 'viewer' },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toMatchObject({
      email: 'viewer@example.com',
      role: 'viewer',
      invited: true,
    });
    expect(sent[0]).toMatchObject({ email: 'viewer@example.com', purpose: 'invite' });
    expect(sent[0]!.links[0]!.orgId).toBe(org.id);

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { code: codeOf(sent[0]!.links[0]!.url) },
    });
    const viewer = verify.json<{ token: string; role: string }>();
    expect(viewer.role).toBe('viewer');
    // Viewers see the dashboard but not the team.
    expect((await app.inject({ url: '/v1/org', headers: bearer(viewer.token) })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/v1/users', headers: bearer(viewer.token) })).statusCode).toBe(
      403,
    );

    const list = await app.inject({ url: '/v1/users', headers: bearer(owner) });
    expect(list.json<{ items: { email: string }[] }>().items.map((u) => u.email)).toEqual([
      'owner@example.com',
      'viewer@example.com',
    ]);

    const again = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(owner),
      payload: { email: 'viewer@example.com', role: 'admin' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('ends a person’s sessions when their role changes or they are removed', async () => {
    await orgWithOwner('boss@example.com');
    const { token: owner } = await signIn('boss@example.com');
    const invited = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(owner),
      payload: { email: 'pat@example.com', role: 'admin' },
    });
    const patId = invited.json<{ id: string }>().id;
    const { token: pat } = await signIn('pat@example.com');
    expect((await app.inject({ url: '/v1/users', headers: bearer(pat) })).statusCode).toBe(200);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${patId}`,
      headers: bearer(owner),
      payload: { role: 'viewer' },
    });
    expect(demote.json()).toMatchObject({ role: 'viewer' });
    expect((await app.inject({ url: '/v1/org', headers: bearer(pat) })).statusCode).toBe(401);
    const { token: patViewer, role } = await signIn('pat@example.com');
    expect(role).toBe('viewer');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${patId}`,
      headers: bearer(owner),
    });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/org', headers: bearer(patViewer) })).statusCode).toBe(401);
    // Removed people get no links.
    sent = [];
    await app.inject({
      method: 'POST',
      url: '/v1/auth/email',
      payload: { email: 'pat@example.com' },
    });
    expect(sent).toHaveLength(0);

    // Invited back, they are the same person.
    const back = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(owner),
      payload: { email: 'pat@example.com', role: 'viewer' },
    });
    expect(back.json()).toMatchObject({ id: patId, role: 'viewer' });
  });

  it('keeps at least one owner', async () => {
    const org = await orgWithOwner('solo@example.com');
    const { token } = await signIn('solo@example.com');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${org.ownerId}`,
      headers: bearer(token),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'last_owner' });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/users/${org.ownerId}`,
          headers: bearer(token),
        })
      ).statusCode,
    ).toBe(409);

    // With a second owner, the first may step down.
    await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(token),
      payload: { email: 'second@example.com', role: 'owner' },
    });
    const step = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${org.ownerId}`,
      headers: bearer(token),
      payload: { role: 'admin' },
    });
    expect(step.json()).toMatchObject({ role: 'admin' });
  });

  it('only lets owners change the team, and only within their org', async () => {
    const a = await orgWithOwner('a-owner@example.com');
    await orgWithOwner('b-owner@example.com');
    const { token: bOwner } = await signIn('b-owner@example.com');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${a.ownerId}`,
      headers: bearer(bOwner),
    });
    expect(res.statusCode).toBe(404);
  });
});
