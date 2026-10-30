import { BudgetEngine } from '@spend-brake/budget';
import { eq, orgs } from '@spend-brake/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signLicense } from '../src/license/license.js';
import { eeLicenses } from '../src/schema.js';
import {
  ACTION_SECRET,
  type Env,
  bearer,
  anotherLogin,
  installLicense,
  issuer,
  license,
  newOrg,
  ssoConfigured,
  ssoPerson,
  startEnv,
} from './harness.js';

let env: Env;
const NOW = new Date('2026-10-30T12:00:00Z');

beforeAll(async () => {
  env = await startEnv({ licensedOrg: false });
});

afterAll(async () => {
  await env.stop();
});

beforeEach(async () => {
  env.clock.now = NOW;
  await env.db.delete(eeLicenses);
  env.ent.forget();
});

const call = (method: string, url: string, tok: string, payload?: object) =>
  env.app.inject({
    method: method as 'GET',
    url,
    headers: bearer(tok),
    ...(payload ? { payload } : {}),
  });

const hardCap = async (orgId: string) =>
  (await new BudgetEngine(env.valkey).getCap(orgId, { kind: 'org' }, 'd'))?.hard?.toString() ??
  null;

describe('without a license', () => {
  it('core features work and ee features explain what they need', async () => {
    const org = await newOrg(env);
    expect((await call('GET', '/v1/license', org.viewer)).json()).toMatchObject({
      status: 'missing',
      license: null,
    });
    // Core: keys and caps, including raising a cap, work as always.
    expect((await call('POST', '/v1/kill', org.admin, { target: 'prov:x' })).statusCode).toBe(200);
    expect((await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 1000 } })).statusCode).toBe(
      200,
    );
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 5000 } })).json(),
    ).toMatchObject({
      items: [{ hard: 5000 }],
    });
    for (const [method, url] of [
      ['GET', '/v1/approvals'],
      ['GET', '/v1/reconciliation'],
      ['GET', '/v1/audit/export'],
      ['GET', '/v1/roles'],
      ['GET', '/v1/orgs'],
    ] as const) {
      const res = await call(method, url, org.owner);
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ error: 'license_required' });
    }
  });
});

describe('installing a license', () => {
  it('accepts a valid license from an owner of its org only', async () => {
    const org = await newOrg(env, `lic-${Date.now()}`);
    const l = license({ org: org.id });
    const file = signLicense(l, issuer.privateKey);
    expect((await call('POST', '/v1/license', org.admin, { license: file })).statusCode).toBe(403);
    const other = await newOrg(env);
    expect(
      (await call('POST', '/v1/license', other.owner, { license: file })).json(),
    ).toMatchObject({
      error: 'license_wrong_org',
    });
    const res = await call('POST', '/v1/license', org.owner, { license: file });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'active', license: { id: l.id, org: org.id } });
  });

  it('rejects tampered, wrong-key and already expired licenses', async () => {
    const org = await newOrg(env, `lic2-${Date.now()}`);
    const file = signLicense(license({ org: org.id }), issuer.privateKey);
    const doc = JSON.parse(file) as { payload: string; signature: string };
    const tampered = JSON.stringify({
      ...doc,
      signature: doc.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    });
    expect(
      (await call('POST', '/v1/license', org.owner, { license: tampered })).json(),
    ).toMatchObject({
      error: 'license_bad_signature',
    });
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const wrongKey = signLicense(license({ org: org.id }), other.privateKey);
    expect(
      (await call('POST', '/v1/license', org.owner, { license: wrongKey })).json(),
    ).toMatchObject({
      error: 'license_bad_signature',
    });
    const old = signLicense(
      license({ org: org.id, expiresAt: '2026-10-01T00:00:00.000Z' }),
      issuer.privateKey,
    );
    expect((await call('POST', '/v1/license', org.owner, { license: old })).json()).toMatchObject({
      error: 'license_expired',
    });
  });

  it('ignores a license row edited in the database', async () => {
    const raw = await installLicense(env, license({ org: 'acme' }));
    const doc = JSON.parse(raw) as { payload: string };
    const forged = JSON.parse(Buffer.from(doc.payload, 'base64url').toString()) as object;
    await env.db
      .update(eeLicenses)
      .set({
        raw: JSON.stringify({
          ...doc,
          payload: Buffer.from(JSON.stringify({ ...forged, orgUnits: 999 })).toString('base64url'),
        }),
      })
      .where(eq(eeLicenses.orgId, 'acme'));
    env.ent.forget();
    expect((await env.ent.state()).status).toBe('missing');
  });
});

describe('two-person approval for raising caps', () => {
  const setUp = async () => {
    await installLicense(env, license());
    const org = await newOrg(env);
    const ana = await ssoPerson(env, org.id, 'ana@example.com', 'admin');
    const bob = await ssoPerson(env, org.id, 'bob@example.com', 'admin');
    const boss = await ssoPerson(env, org.id, 'boss@example.com', 'owner');
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 1_000_000 } })).statusCode,
    ).toBe(200);
    return { org, ana, bob, boss };
  };

  it('needs single sign-on before it can be switched on', async () => {
    await installLicense(env, license());
    const org = await newOrg(env);
    const res = await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'sso_required' });
  });

  it('blocks a single-person raise until someone else approves it', async () => {
    const { org, ana, bob } = await setUp();
    await ssoConfigured(env, org.id);
    expect(
      (await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true })).json(),
    ).toEqual({
      capApprovals: true,
    });

    // Lowering applies at once.
    expect(
      (await call('PUT', '/v1/caps/org', ana, { day: { hard: 500_000 } })).json(),
    ).toMatchObject({
      items: [{ hard: 500_000 }],
    });
    // Raising is held.
    const raise = await call('PUT', '/v1/caps/org', ana, { day: { hard: 9_000_000 } });
    expect(raise.statusCode).toBe(200);
    const body = raise.json<{ items: unknown[]; pending: { approvalId: string }[] }>();
    expect(body.items).toEqual([]);
    const id = body.pending[0]!.approvalId;
    expect(await hardCap(org.id)).toBe('500000');
    // Removing the cap is a raise too (the month has no cap, so only the day's waits).
    expect((await call('DELETE', '/v1/caps/org', ana)).json()).toMatchObject({
      deleted: ['m'],
      pending: [{ kind: 'd' }],
    });
    expect(await hardCap(org.id)).toBe('500000');

    // The requester cannot approve, not even from a second login; nor can a viewer.
    for (const t of [ana, await anotherLogin(env, ana)]) {
      const self = await call('POST', `/v1/approvals/${id}/approve`, t);
      expect(self.json()).toMatchObject({ error: 'second_person_required' });
    }
    expect((await call('POST', `/v1/approvals/${id}/approve`, org.viewer)).statusCode).toBe(403);
    expect(await hardCap(org.id)).toBe('500000');

    // Another person approves: applied once.
    const ok = await call('POST', `/v1/approvals/${id}/approve`, bob);
    expect(ok.json()).toMatchObject({ status: 'approved', toHard: 9_000_000 });
    expect(await hardCap(org.id)).toBe('9000000');
    expect((await call('POST', `/v1/approvals/${id}/approve`, org.owner)).statusCode).toBe(403);
    const events = await call('GET', '/v1/events?source=audit', org.viewer);
    expect(events.body).toContain('cap.raise.requested');
    expect(events.body).toContain('cap.raise.approved');
  });

  it('gives an owner no way to approve their own raise', async () => {
    const { org } = await setUp();
    await ssoConfigured(env, org.id);
    await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true });
    // Plain tokens name no person: they can neither ask nor approve.
    const asOwner = await call('PUT', '/v1/caps/org', org.owner, { day: { hard: 5_000_000 } });
    expect(asOwner.json()).toMatchObject({ error: 'sso_required' });
    const minted = (
      await call('POST', '/v1/tokens', org.owner, { name: 'second', role: 'admin' })
    ).json<{ token: string }>().token;
    expect(
      (await call('PUT', '/v1/caps/org', minted, { day: { hard: 5_000_000 } })).json(),
    ).toMatchObject({
      error: 'sso_required',
    });
    const billing = (
      await call('POST', '/v1/roles/tokens', org.owner, { name: 'b', role: 'billing' })
    ).json<{ token: string }>().token;
    const boss = await ssoPerson(env, org.id, 'solo@example.com', 'owner');
    const held = await call('PUT', '/v1/caps/org', boss, { day: { hard: 5_000_000 } });
    const id = held.json<{ pending: { approvalId: string }[] }>().pending[0]!.approvalId;
    for (const t of [org.owner, minted, billing]) {
      expect((await call('POST', `/v1/approvals/${id}/approve`, t)).json()).toMatchObject({
        error: 'sso_required',
      });
    }
    // Switching approvals off is itself held for a second person (an owner).
    const off = await call('PUT', '/v1/approvals/policy', boss, { capApprovals: false });
    expect(off.json<{ capApprovals: boolean; pendingApproval: string }>()).toMatchObject({
      capApprovals: true,
      pendingApproval: expect.stringMatching(/^apr_/) as string,
    });
    expect((await call('GET', '/v1/approvals/policy', org.viewer)).json()).toEqual({
      capApprovals: true,
    });
    expect(
      (await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: false })).json(),
    ).toMatchObject({
      error: 'sso_required',
    });
    expect(await hardCap(org.id)).toBe('1000000');
  });

  it('refuses raises from alert links while approvals are on', async () => {
    const { org } = await setUp();
    await ssoConfigured(env, org.id);
    await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true });
    const { signAction } = await import('@spend-brake/shared');
    const link = signAction(ACTION_SECRET, {
      act: 'raise',
      org: org.id,
      target: 'org',
      kind: 'd',
      amount: '25000000',
      exp: Math.floor(env.clock.now.getTime() / 1000) + 600,
    });
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/actions/execute',
      payload: { token: link },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'approval_required' });
    expect(await hardCap(org.id)).toBe('1000000');
  });

  it('lets an owner decide on switching approvals off, then lets raises through', async () => {
    const { org, bob, boss } = await setUp();
    await ssoConfigured(env, org.id);
    await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true });
    const id = (await call('PUT', '/v1/approvals/policy', boss, { capApprovals: false })).json<{
      pendingApproval: string;
    }>().pendingApproval;
    expect(id).toMatch(/^apr_/);
    const second = await ssoPerson(env, org.id, 'second-owner@example.com', 'owner');
    expect((await call('POST', `/v1/approvals/${id}/approve`, bob)).json()).toMatchObject({
      error: 'forbidden',
    });
    expect((await call('POST', `/v1/approvals/${id}/approve`, boss)).json()).toMatchObject({
      error: 'second_person_required',
    });
    expect((await call('POST', `/v1/approvals/${id}/approve`, second)).json()).toMatchObject({
      status: 'approved',
    });
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 7_000_000 } })).json(),
    ).toMatchObject({
      items: [{ hard: 7_000_000 }],
    });
  });

  it('lets raises through again once the license is read-only (caps are never locked)', async () => {
    await installLicense(env, license({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    const org = await newOrg(env);
    const ana = await ssoPerson(env, org.id, 'ana@example.com', 'admin');
    await ssoConfigured(env, org.id);
    await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 1000 } });
    // In the grace period approvals still hold raises.
    env.clock.now = new Date('2026-10-10T00:00:00Z');
    env.ent.forget();
    expect(
      (await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true })).statusCode,
    ).toBe(200);
    expect((await call('PUT', '/v1/caps/org', ana, { day: { hard: 2000 } })).json()).toMatchObject({
      pending: [{ kind: 'd' }],
    });
    // Past the grace period: ee is read-only, the core raise applies directly.
    env.clock.now = new Date('2026-10-20T00:00:00Z');
    env.ent.forget();
    expect((await call('GET', '/v1/license', org.viewer)).json()).toMatchObject({
      status: 'expired',
    });
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 3000 } })).json(),
    ).toMatchObject({
      items: [{ hard: 3000 }],
    });
    expect((await call('GET', '/v1/approvals', org.viewer)).statusCode).toBe(200);
    const change = await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: false });
    expect(change.statusCode).toBe(403);
    expect(change.json()).toMatchObject({ error: 'license_expired' });
  });
});

describe('roles beyond owner, admin and viewer', () => {
  it('gives operators the kill switch and keys but not caps; auditors the export', async () => {
    await installLicense(env, license());
    const org = await newOrg(env);
    const mk = async (role: string) =>
      (await call('POST', '/v1/roles/tokens', org.owner, { name: role, role })).json<{
        token: string;
      }>().token;
    const operator = await mk('operator');
    const auditor = await mk('auditor');
    expect((await call('POST', '/v1/kill', operator, { target: 'org' })).statusCode).toBe(200);
    expect((await call('POST', '/v1/unkill', operator, { target: 'org' })).statusCode).toBe(200);
    expect((await call('PUT', '/v1/caps/org', operator, { day: { hard: 1 } })).statusCode).toBe(
      403,
    );
    // Keys carry budgets and credentials: operators revoke them but do not create or edit them.
    expect((await call('POST', '/v1/keys', operator, { name: 'k' })).statusCode).toBe(403);
    expect(
      (await call('PATCH', '/v1/keys/k_x', operator, { sessionCapMicros: 1 })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', '/v1/keys/k_missing', operator)).statusCode).toBe(404);
    expect((await call('POST', '/v1/providers/credentials', operator, {})).statusCode).toBe(403);
    expect((await call('GET', '/v1/keys', operator)).statusCode).toBe(200);

    const exported = await call('GET', '/v1/audit/export', auditor);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    const lines = exported.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { action: string; orgId: string });
    expect(lines.map((l) => l.action)).toEqual(
      expect.arrayContaining(['kill', 'unkill', 'token.create']),
    );
    expect(lines.every((l) => l.orgId === org.id)).toBe(true);
    expect((await call('POST', '/v1/kill', auditor, { target: 'org' })).statusCode).toBe(403);

    // Without a license the same tokens are plain viewers.
    await env.db.delete(eeLicenses);
    env.ent.forget();
    expect((await call('POST', '/v1/kill', operator, { target: 'org' })).statusCode).toBe(403);
    expect((await call('GET', '/v1/keys', operator)).statusCode).toBe(200);
  });
});

describe('multi-org', () => {
  it("lets the licensed org's owners create orgs up to orgUnits", async () => {
    const home = await newOrg(env, `home-${Date.now()}`);
    const existing = await env.db.$count(orgs);
    await installLicense(env, license({ org: home.id, orgUnits: existing + 1 }));
    const other = await newOrg(env);
    // Another org's owner cannot.
    expect(
      (await call('POST', '/v1/orgs', other.owner, { id: 'nope', name: 'x' })).statusCode,
    ).toBe(403);
    // newOrg above used one unit; the license allowed exactly one more before it.
    const full = await call('POST', '/v1/orgs', home.owner, {
      id: `team-${Date.now()}`,
      name: 'Team',
    });
    expect(full.json()).toMatchObject({ error: 'org_limit' });
    await installLicense(env, license({ org: home.id, orgUnits: existing + 5 }));
    const created = await call('POST', '/v1/orgs', home.owner, {
      id: `team-${Date.now()}`,
      name: 'Team',
    });
    expect(created.statusCode).toBe(201);
    const { ownerToken, orgId } = created.json<{ ownerToken: string; orgId: string }>();
    // The new org is a separate tenant with its own owner.
    const me = await call('GET', '/v1/org', ownerToken);
    expect(me.json()).toMatchObject({ id: orgId });
    expect(
      (await call('GET', '/v1/orgs', home.owner)).json<{ items: unknown[] }>().items.length,
    ).toBe(existing + 2);
  });
});
