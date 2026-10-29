import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { toMicros, usd } from '../src/api.js';

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  routes = {
    'GET /v1/org': (c) =>
      c.auth === 'Bearer sbt_good' ? [200, { id: 'acme' }] : [401, { message: 'bad token' }],
    'GET /v1/status': () => [
      200,
      {
        killed: ['key:k2'],
        scopes: [
          {
            scope: 'org',
            window: 'd:20261029',
            spent: 4_000_000,
            held: 100_000,
            hard: 5_000_000,
            soft: null,
            remaining: 900_000,
          },
          {
            scope: 'key:k1',
            window: 'd:20261029',
            spent: 1_000,
            held: 0,
            hard: null,
            soft: null,
            remaining: null,
          },
          {
            scope: 'key:k2',
            window: 'd:20261029',
            spent: 0,
            held: 0,
            hard: null,
            soft: null,
            remaining: null,
          },
        ],
      },
    ],
    'POST /v1/kill': () => [200, { killed: ['key:k1', 'key:k2'] }],
    'POST /v1/unkill': () => [200, { killed: [] }],
    'GET /v1/caps': () => [
      200,
      { items: [{ scope: 'org', kind: 'd', hard: 5_000_000, soft: null, version: 1 }] },
    ],
    'PUT /v1/caps/key%3Ak1': () => [200, { items: [] }],
    'GET /v1/spend': (c) =>
      c.url.includes('groupBy=day')
        ? [
            200,
            {
              items: [
                { day: '2026-10-28', costMicros: 32_000, requests: 1 },
                { day: '2026-10-29', costMicros: 10_000, requests: 2 },
              ],
            },
          ]
        : [200, { items: [{ key: 'k1', costMicros: 42_000, requests: 3 }] }],
  };
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const c: Call = {
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: (init.headers as Record<string, string> | undefined)?.authorization,
    };
    calls.push(c);
    const route = routes[`${c.method} ${url.split('?')[0]}`];
    const [status, body] = route ? route(c) : [404, { message: `no route ${c.method} ${url}` }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function signIn() {
  const user = userEvent.setup();
  render(<App client={client()} />);
  await user.type(screen.getByLabelText('Admin API token'), 'sbt_good');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Live budget' });
  return user;
}

describe('money helpers', () => {
  it('parses dollars exactly and formats micros', () => {
    expect(toMicros('12.5')).toBe(12_500_000);
    expect(toMicros('$0.000001')).toBe(1);
    expect(toMicros('1e3')).toBeNull();
    expect(usd(4_000_000)).toBe('$4.00');
    expect(usd(null)).toBe('—');
  });
});

describe('dashboard', () => {
  it('rejects a bad token and keeps it out of storage', async () => {
    const user = userEvent.setup();
    render(<App client={client()} />);
    await user.type(screen.getByLabelText('Admin API token'), 'sbt_bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That token is not valid.')).toBeTruthy();
    expect(sessionStorage.getItem('brake.adminToken')).toBeNull();
  });

  it('shows live budget and drives the kill switch', async () => {
    const user = await signIn();
    expect(screen.getAllByText('$0.9000').length).toBeGreaterThan(0);
    const org = screen.getByText('org', { selector: '.kills code' }).closest('li')!;
    await user.click(within(org).getByRole('button', { name: 'Kill' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/kill')).toBe(true),
    );
    expect(calls.find((c) => c.url === '/v1/kill')!.body).toEqual({
      target: 'org',
      reason: 'dashboard',
    });
    const k2 = screen.getByText('key:k2', { selector: '.kills code' }).closest('li')!;
    await user.click(within(k2).getByRole('button', { name: 'Lift kill' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/unkill')).toBe(true));
    expect(calls.every((c) => c.auth === 'Bearer sbt_good' || c.url === '/v1/org')).toBe(true);
  });

  it('edits caps in exact micros and rejects malformed amounts', async () => {
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Caps' }));
    await screen.findByRole('heading', { name: 'Caps' });
    const form = screen.getByRole('form', { name: 'Set a cap' });
    const scope = within(form).getByLabelText('Scope');
    await user.clear(scope);
    await user.type(scope, 'key:k1');
    await user.type(within(form).getByLabelText('Hard cap ($)'), 'lots');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Amounts are dollars, like 5 or 12.50.')).toBeTruthy();
    await user.clear(within(form).getByLabelText('Hard cap ($)'));
    await user.type(within(form).getByLabelText('Hard cap ($)'), '12.50');
    await user.type(within(form).getByLabelText('Soft limit ($)'), '10');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/v1/caps/key%3Ak1',
      body: { day: { hard: 12_500_000, soft: 10_000_000 } },
    });
  });

  it('opens the page named in the URL hash and lists webhook deliveries', async () => {
    routes['GET /v1/webhooks'] = () => [
      200,
      {
        items: [
          {
            id: 'wh1',
            name: 'ops',
            preset: 'slack',
            urlHint: 'https://hooks.slack.com',
            events: [],
            createdAt: '',
          },
        ],
      },
    ];
    routes['GET /v1/webhooks/wh1/deliveries'] = () => [
      200,
      {
        items: [
          {
            alertId: 'a1',
            type: 'loop',
            attempt: 2,
            ok: false,
            httpStatus: 500,
            error: 'HTTP 500',
            at: '2026-10-29T10:00:00Z',
          },
        ],
      },
    ];
    window.location.hash = '#/webhooks';
    const user = userEvent.setup();
    sessionStorage.setItem('brake.adminToken', 'sbt_good');
    render(<App client={client()} />);
    expect(await screen.findByRole('heading', { name: 'Alert webhooks' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Delivery log' }));
    expect(await screen.findByText('failed')).toBeTruthy();
    expect(screen.getByText('https://hooks.slack.com')).toBeTruthy();
    window.location.hash = '';
  });

  it('charts spend and totals the period', async () => {
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Spend' }));
    expect(await screen.findByText('$0.04')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    expect(await screen.findByText('$0.0420')).toBeTruthy();
  });
});
