import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('proxy server', () => {
  it('answers health checks', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'proxy' });
    await app.close();
  });
});
