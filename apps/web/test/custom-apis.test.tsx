import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { setToken } from '../src/api.js';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;
let role: 'owner' | 'admin' | 'viewer';

const ACME = {
  id: 'acme',
  name: 'Acme Search',
  origin: 'https://api.acme.example',
  auth: { type: 'header', name: 'X-Api-Key', valuePrefix: '' },
  routes: [
    {
      method: 'POST',
      path: '/v1/search',
      sku: 'search',
      pricing: { model: 'perRequest', usd: '0.005' },
    },
  ],
  billed: '2xx',
  timeoutBilled: true,
  proxyPath: '/custom/acme',
  createdAt: '2026-10-30T10:00:00Z',
  updatedAt: '2026-10-30T10:00:00Z',
};

beforeEach(() => {
  calls = [];
  role = 'owner';
  sessionStorage.clear();
  setToken('sbt_good');
  routes = {
    'GET /v1/auth/session': () => [200, { orgId: 'org1', role, actor: 'token:t1' }],
    'GET /v1/auth/options': () => [
      200,
      { emailSignIn: false, signup: false, proxyUrl: 'https://proxy.example.net', egressIps: [] },
    ],
    'GET /v1/custom-apis': () => [200, { items: [ACME] }],
    'GET /v1/providers/credentials': () => [200, { items: [] }],
    'GET /v1/keys': () => [200, { items: [] }],
  };
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const c: Call = {
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
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
  setToken(null);
  window.location.hash = '';
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function open(page: string) {
  window.location.hash = `#/${page}`;
  render(<App client={client()} />);
  return userEvent.setup();
}

describe('Custom APIs page', () => {
  it('lists custom APIs with the proxy URL to call and a link to the docs', async () => {
    open('customapis');
    expect(await screen.findByText('Acme Search')).toBeTruthy();
    expect(screen.getByText('https://proxy.example.net/custom/acme/…')).toBeTruthy();
    const row = screen.getByText('Acme Search').closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How custom APIs work' }).getAttribute('href')).toBe(
      'https://docs.spendbrake.dev/custom-apis/',
    );
    expect(screen.getByText(/only as accurate as the prices/)).toBeTruthy();
  });

  it('lets admins add one with a reported-cost route', async () => {
    routes['POST /v1/custom-apis'] = (c) => [201, { ...ACME, ...(c.body as object) }];
    const user = open('customapis');
    const form = await screen.findByRole('form', { name: 'Add a custom API' });
    const f = within(form);
    await user.type(f.getByLabelText('Id'), 'credits');
    await user.type(f.getByLabelText('Name'), 'Credits API');
    await user.clear(f.getByLabelText('Origin'));
    await user.type(f.getByLabelText('Origin'), 'https://api.credits.example');
    await user.clear(f.getByLabelText('Route 1 path'));
    await user.type(f.getByLabelText('Route 1 path'), '/v1/run');
    await user.selectOptions(f.getByLabelText('Route 1 method'), 'POST');
    await user.type(f.getByLabelText('Route 1 SKU'), 'run');
    await user.selectOptions(f.getByLabelText('Route 1 pricing'), 'reported');
    await user.selectOptions(f.getByLabelText('Route 1 reported in'), 'json');
    await user.type(f.getByLabelText('Route 1 JSON path'), 'usage.credits');
    await user.clear(f.getByLabelText('Route 1 USD per unit'));
    await user.type(f.getByLabelText('Route 1 USD per unit'), '0.001');
    await user.type(f.getByLabelText('Route 1 max USD per request'), '0.50');
    await user.click(f.getByRole('button', { name: 'Add custom API' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      id: 'credits',
      name: 'Credits API',
      origin: 'https://api.credits.example',
      auth: { type: 'header', name: 'Authorization', valuePrefix: 'Bearer ' },
      routes: [
        {
          method: 'POST',
          path: '/v1/run',
          sku: 'run',
          pricing: {
            model: 'reported',
            jsonPath: 'usage.credits',
            usdPerUnit: '0.001',
            maxPerRequest: '0.50',
          },
        },
      ],
      billed: '2xx',
      timeoutBilled: true,
    });
  });

  it('edits with the stored definition and sends it without the id', async () => {
    routes['PUT /v1/custom-apis/acme'] = (c) => [200, { ...ACME, ...(c.body as object) }];
    const user = open('customapis');
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Search' }));
    const form = screen.getByRole('form', { name: 'Edit Acme Search' });
    expect(within(form).getByLabelText('Route 1 USD per request')).toHaveProperty('value', '0.005');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(body.id).toBeUndefined();
    expect(body).toMatchObject({ name: 'Acme Search', routes: ACME.routes });
  });

  it('shows why a delete was refused', async () => {
    routes['DELETE /v1/custom-apis/acme'] = () => [
      409,
      { error: 'custom_api_in_use', message: 'Spend Brake key "agent" calls Acme Search.' },
    ];
    vi.stubGlobal('confirm', () => true);
    const user = open('customapis');
    await user.click(await screen.findByRole('button', { name: 'Delete Acme Search' }));
    expect(await screen.findByText('Spend Brake key "agent" calls Acme Search.')).toBeTruthy();
  });

  it('shows viewers the list without controls', async () => {
    role = 'viewer';
    open('customapis');
    expect(await screen.findByText('Acme Search')).toBeTruthy();
    expect(await screen.findByText(/Admins and owners can add/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Acme Search' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a custom API' })).toBeNull();
  });
});

describe('custom APIs as providers', () => {
  it('can take a provider key, which shows under its name', async () => {
    routes['POST /v1/providers/credentials'] = () => [
      201,
      {
        id: 'cred1',
        provider: 'acme',
        name: 'Acme Search',
        hint: '1234',
        createdAt: '',
        reboundKeys: [],
      },
    ];
    const user = open('keys');
    const select = await screen.findByLabelText('Provider');
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Acme Search' })).toBeTruthy(),
    );
    await user.selectOptions(select, 'acme');
    await user.type(screen.getByLabelText(/Your Acme Search API key/), 'acme-secret-1234');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        provider: 'acme',
        name: 'Acme Search',
        secret: 'acme-secret-1234',
      }),
    );
  });

  it('names custom APIs in the provider key list and key creation', async () => {
    routes['GET /v1/providers/credentials'] = () => [
      200,
      {
        items: [
          {
            id: 'cred1',
            provider: 'acme',
            name: 'Acme Search',
            hint: '1234',
            createdAt: '2026-10-30T10:00:00Z',
          },
        ],
      },
    ];
    open('keys');
    await waitFor(() => expect(screen.getAllByText('Acme Search').length).toBeGreaterThan(0));
    const create = screen.getByRole('group', { name: 'Can call' });
    expect(within(create).getByLabelText('Acme Search')).toBeTruthy();
  });
});
