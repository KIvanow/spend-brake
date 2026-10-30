import { BudgetEngine } from '@spend-brake/budget';
import { eq, orgs } from '@spend-brake/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signLicense } from '../src/license/license.js';
import { eeLicenses } from '../src/schema.js';
import {
  type Env,
  bearer,
  installLicense,
  issuer,
  license,
  newOrg,
  startEnv,
  token,
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
  it('blocks a single-person raise until someone else approves it', async () => {
    await installLicense(env, license());
    const org = await newOrg(env);
    const second = await token(env, org.id, 'admin');
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 1_000_000 } })).statusCode,
    ).toBe(200);
    expect(
      (await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true })).json(),
    ).toEqual({
      capApprovals: true,
    });

    // Lowering applies at once.
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 500_000 } })).json(),
    ).toMatchObject({
      items: [{ hard: 500_000 }],
    });
    // Raising is held.
    const raise = await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 9_000_000 } });
    expect(raise.statusCode).toBe(200);
    const body = raise.json<{ items: unknown[]; pending: { approvalId: string }[] }>();
    expect(body.items).toEqual([]);
    const id = body.pending[0]!.approvalId;
    expect(await hardCap(org.id)).toBe('500000');
    // Removing the cap is a raise too.
    const remove = await call('DELETE', '/v1/caps/org', org.admin);
    // The month has no cap, so only the day's removal waits.
    expect(remove.json()).toMatchObject({ deleted: ['m'], pending: [{ kind: 'd' }] });
    expect(await hardCap(org.id)).toBe('500000');

    // The requester cannot approve their own raise, nor can a viewer.
    const self = await call('POST', `/v1/approvals/${id}/approve`, org.admin);
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ error: 'second_person_required' });
    expect((await call('POST', `/v1/approvals/${id}/approve`, org.viewer)).statusCode).toBe(403);
    expect(await hardCap(org.id)).toBe('500000');

    // A second admin approves: applied once.
    const ok = await call('POST', `/v1/approvals/${id}/approve`, second);
    expect(ok.json()).toMatchObject({ status: 'approved', toHard: 9_000_000 });
    expect(await hardCap(org.id)).toBe('9000000');
    expect((await call('POST', `/v1/approvals/${id}/approve`, org.owner)).json()).toMatchObject({
      error: 'not_pending',
    });
    const events = await call('GET', '/v1/events?source=audit', org.viewer);
    expect(events.body).toContain('cap.raise.requested');
    expect(events.body).toContain('cap.raise.approved');
  });

  it('lets raises through again once the license is read-only (caps are never locked)', async () => {
    await installLicense(env, license({ expiresAt: '2026-10-01T00:00:00.000Z' }));
    const org = await newOrg(env);
    await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 1000 } });
    // In grace (30 Oct is within 14 days of 1 Oct? no: 29 days) -> move the clock into grace.
    env.clock.now = new Date('2026-10-10T00:00:00Z');
    env.ent.forget();
    expect(
      (await call('PUT', '/v1/approvals/policy', org.owner, { capApprovals: true })).statusCode,
    ).toBe(200);
    expect(
      (await call('PUT', '/v1/caps/org', org.admin, { day: { hard: 2000 } })).json(),
    ).toMatchObject({
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
    // Reads still work; changes say why they do not.
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
