import { reconciliationResults, sql } from '@spend-brake/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Env, bearer, newOrg, startEnv } from './harness.js';

let env: Env;
const PRIVATE = '-----BEGIN PRIVATE KEY-----\nSECRET-MATERIAL\n-----END PRIVATE KEY-----\n';
const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'billing-proj',
  client_email: 'reader@billing-proj.iam.gserviceaccount.com',
  private_key: PRIVATE,
});

beforeAll(async () => {
  env = await startEnv();
});

afterAll(async () => {
  await env.stop();
});

describe('reconciliation settings', () => {
  it('says spend is proxy-measured until an export is connected', async () => {
    const org = await newOrg(env);
    const res = await env.app.inject({ url: '/v1/reconciliation', headers: bearer(org.viewer) });
    expect(res.json()).toMatchObject({
      configured: false,
      message: expect.stringContaining('measured by the proxy only') as string,
    });
  });

  it('stores the service account encrypted and never returns it', async () => {
    const org = await newOrg(env);
    const put = (payload: object, token = org.admin) =>
      env.app.inject({ method: 'PUT', url: '/v1/reconciliation', headers: bearer(token), payload });
    expect(
      (
        await put(
          { exportTable: 'billing-proj.billing.gcp_billing_export_v1_X', serviceAccountJson: SA },
          org.viewer,
        )
      ).statusCode,
    ).toBe(403);
    for (const bad of [
      { exportTable: 'not a table', serviceAccountJson: SA },
      { exportTable: 'a.b.c', serviceAccountJson: '{"type":"authorized_user"}' },
      { exportTable: 'a.b.c', serviceAccountJson: 'nope' },
      { exportTable: 'a.b.c', serviceAccountJson: SA, projectIds: ['Bad_Project'] },
    ]) {
      const r = await put(bad);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect(r.body).not.toContain('SECRET-MATERIAL');
    }
    const ok = await put({
      exportTable: 'billing-proj.billing.gcp_billing_export_v1_X',
      serviceAccountJson: SA,
      projectIds: ['maps-prod-123'],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      configured: true,
      serviceAccount: 'reader@billing-proj.iam.gserviceaccount.com',
      projectIds: ['maps-prod-123'],
    });
    expect(ok.body).not.toContain('SECRET-MATERIAL');
    const get = await env.app.inject({ url: '/v1/reconciliation', headers: bearer(org.viewer) });
    expect(get.body).not.toContain('SECRET-MATERIAL');
    const stored = await env.db.execute(
      sql`select envelope::text as e from reconciliation_configs`,
    );
    expect(JSON.stringify(stored.rows)).not.toContain('SECRET-MATERIAL');
    expect(env.logs.text()).not.toContain('SECRET-MATERIAL');

    const del = await env.app.inject({
      method: 'DELETE',
      url: '/v1/reconciliation',
      headers: bearer(org.admin),
    });
    expect(del.json()).toEqual({ deleted: true });
  });

  it('reports drift per day and family, for the caller org only', async () => {
    const a = await newOrg(env);
    const b = await newOrg(env);
    await env.db.insert(reconciliationResults).values([
      {
        orgId: a.id,
        day: '2026-10-28',
        family: 'total',
        ledgerMicros: 1_000_000n,
        billedMicros: 1_100_000n,
        driftRatio: 0.0909,
      },
      {
        orgId: a.id,
        day: '2026-10-28',
        family: 'geocoding',
        ledgerMicros: 1_000_000n,
        billedMicros: 1_100_000n,
        driftRatio: 0.0909,
      },
      {
        orgId: b.id,
        day: '2026-10-28',
        family: 'total',
        ledgerMicros: 9n,
        billedMicros: 9n,
        driftRatio: 0,
      },
    ]);
    const res = await env.app.inject({
      url: '/v1/reconciliation/report?from=2026-10-01',
      headers: bearer(a.viewer),
    });
    expect(res.json<{ items: { family: string }[] }>().items.map((i) => i.family)).toEqual([
      'geocoding',
      'total',
    ]);
  });
});
