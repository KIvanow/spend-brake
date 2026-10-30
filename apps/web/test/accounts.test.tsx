import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { getToken, setToken, takeLoginCode } from '../src/api.js';
import { redeemLoginCode } from '../src/pages/Auth.js';

// Node 26 defines its own (empty) localStorage global, which hides jsdom's: stand one in.
if (!window.localStorage) {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  });
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;
const CODE = 'c'.repeat(43);
const options = {
  emailSignIn: true,
  signup: true,
  proxyUrl: 'https://proxy.example.com',
  egressIps: ['203.0.113.7'],
};

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.location.hash = '';
  routes = {
    'GET /v1/auth/options': () => [200, options],
    'POST /v1/auth/email': () => [202, {}],
    'POST /v1/auth/email/verify': (c) =>
      (c.body as { code: string }).code === CODE
        ? [200, { token: 'sbt_email', orgId: 'acme', role: 'owner' }]
        : [
            400,
            { message: 'This sign-in link has expired or was already used. Ask for a new one.' },
          ],
    'GET /v1/org': (c) =>
      c.auth === 'Bearer sbt_email' ? [200, { id: 'acme' }] : [401, { message: 'bad token' }],
    'GET /v1/status': () => [200, { killed: [], scopes: [] }],
    'GET /v1/providers/credentials': () => [200, { items: [] }],
    'GET /v1/keys': () => [200, { items: [] }],
    'GET /v1/caps': () => [200, { items: [] }],
    'GET /v1/spend': () => [200, { items: [] }],
    'GET /v1/billing/plans': () => [
      200,
      {
        signup: true,
        plans: [
          {
            id: 'free',
            name: 'Free',
            monthlyUsd: 0,
            selfHosted: false,
            purchasable: true,
            limits: {
              maxKeys: 1,
              maxProviders: 1,
              requestsPerMonth: 10_000,
              maxOrgMonthCapMicros: 50_000_000,
            },
          },
          {
            id: 'team',
            name: 'Team',
            monthlyUsd: 49,
            selfHosted: false,
            purchasable: true,
            limits: {
              maxKeys: null,
              maxProviders: 5,
              requestsPerMonth: 1_000_000,
              maxOrgMonthCapMicros: null,
            },
          },
          {
            id: 'enterprise',
            name: 'Enterprise',
            monthlyUsd: null,
            selfHosted: true,
            purchasable: false,
            limits: {
              maxKeys: 1,
              maxProviders: 1,
              requestsPerMonth: 10_000,
              maxOrgMonthCapMicros: 50_000_000,
            },
          },
        ],
      },
    ],
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
  setToken(null);
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const signedInByEmail = () => {
  setToken('sbt_email', { remember: true });
  render(<App client={client()} />);
};

describe('email sign-in', () => {
  it('asks for an email, sends a link and says to check the inbox', async () => {
    const user = userEvent.setup();
    render(<App client={client()} />);
    await user.type(await screen.findByLabelText('Email'), ' ana@example.com ');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(calls.find((c) => c.url === '/v1/auth/email')!.body).toEqual({
      email: 'ana@example.com',
    });
    expect(screen.getByText('ana@example.com')).toBeTruthy();
  });

  it('still offers token sign-in, and links to sign-up', async () => {
    const user = userEvent.setup();
    render(<App client={client()} />);
    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in with an API token' }));
    expect(screen.getByLabelText('Admin API token')).toBeTruthy();
  });

  it('takes the code from a link once and clears it from the address bar', () => {
    window.history.replaceState(null, '', `/#login=${CODE}`);
    expect(takeLoginCode()).toBe(CODE);
    expect(window.location.hash).toBe('#/');
    window.history.replaceState(null, '', '/#login=short');
    expect(takeLoginCode()).toBeNull();
  });

  it('signs in with a link and keeps the session across tabs', async () => {
    expect(await redeemLoginCode(CODE)).toBeNull();
    expect(getToken()).toBe('sbt_email');
    expect(window.localStorage.getItem('brake.adminToken')).toBe('sbt_email');
    expect(window.sessionStorage.getItem('brake.adminToken')).toBeNull();
    render(<App client={client()} signingIn={Promise.resolve(null)} />);
    expect(await screen.findByRole('heading', { name: 'Live budget' })).toBeTruthy();
  });

  it('says when a link was used or expired', async () => {
    const error = redeemLoginCode('d'.repeat(43));
    render(<App client={client()} signingIn={error} />);
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
    expect(getToken()).toBeNull();
  });

  it('goes back to sign-in when the session ends', async () => {
    signedInByEmail();
    await screen.findByRole('heading', { name: 'Live budget' });
    // The session ended (expired, or the person's role changed): the next request gets a 401.
    routes['GET /v1/users'] = () => [401, { message: 'Missing or invalid API token.' }];
    window.location.hash = '/team';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(getToken()).toBeNull();
  });
});

describe('sign-up', () => {
  it('creates a Free account and says to check the inbox', async () => {
    window.location.hash = '/signup';
    const user = userEvent.setup();
    routes['POST /v1/billing/signup'] = () => [201, { orgId: 'acme-x1y2z3', emailSent: true }];
    render(<App client={client()} />);
    expect(await screen.findByText('Team')).toBeTruthy();
    // Enterprise is arranged with us, not bought here.
    expect(screen.queryByText('Enterprise')).toBeNull();
    await user.type(screen.getByLabelText('Work email'), 'ana@acme.test');
    await user.type(screen.getByLabelText('Team or project name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    const body = calls.find((c) => c.url === '/v1/billing/signup')!.body as Record<string, string>;
    expect(body).toMatchObject({ name: 'Acme', email: 'ana@acme.test', plan: 'free' });
    expect(body.timeZone).toBeTruthy();
  });

  it('sends a paid plan to Stripe Checkout', async () => {
    window.location.hash = '/signup?plan=team';
    const user = userEvent.setup();
    routes['POST /v1/billing/signup'] = () => [
      201,
      { orgId: 'acme-x1y2z3', emailSent: true, checkoutUrl: 'about:blank' },
    ];
    render(<App client={client()} />);
    await screen.findByText('Team');
    await user.type(screen.getByLabelText('Work email'), 'ana@acme.test');
    await user.type(screen.getByLabelText('Team or project name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/billing/signup')!.body).toMatchObject({
        plan: 'team',
      }),
    );
  });

  it('welcomes people back from Checkout before they sign in', async () => {
    window.location.hash = '/welcome';
    render(<App client={client()} />);
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(screen.getByText(/You're on Free and can upgrade/)).toBeTruthy();
  });
});

describe('team', () => {
  it('invites, changes roles and removes people', async () => {
    const people = [
      { id: 'usr_1', email: 'ana@acme.test', role: 'owner', createdAt: '2026-10-30T10:00:00Z' },
    ];
    routes['GET /v1/users'] = () => [200, { items: people }];
    routes['POST /v1/users'] = (c) => {
      const b = c.body as { email: string; role: string };
      return [201, { id: 'usr_2', ...b, createdAt: '2026-10-30T11:00:00Z', invited: true }];
    };
    routes['PATCH /v1/users/usr_1'] = () => [
      409,
      { error: 'last_owner', message: 'The org needs another owner first.' },
    ];
    routes['DELETE /v1/users/usr_1'] = () => [200, people[0]!];
    window.location.hash = '/team';
    signedInByEmail();
    const user = userEvent.setup();
    await screen.findByText('ana@acme.test');

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'pat@acme.test');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'admin');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/Invited pat@acme.test/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/users')!.body).toEqual({
      email: 'pat@acme.test',
      role: 'admin',
    });

    await user.selectOptions(screen.getByLabelText('Role of ana@acme.test'), 'viewer');
    expect(await screen.findByText('The org needs another owner first.')).toBeTruthy();

    const row = screen.getByText('ana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/v1/users/usr_1')).toBe(true),
    );
  });
});

describe('getting started', () => {
  it('adds a provider key, creates a Spend Brake key and shows how to use it', async () => {
    const creds: { id: string; provider: string; name: string; hint: string; createdAt: string }[] =
      [];
    routes['GET /v1/providers/credentials'] = () => [200, { items: creds }];
    routes['POST /v1/providers/credentials'] = (c) => {
      const b = c.body as { provider: string; name: string; secret: string };
      const row = {
        id: 'cred_1',
        provider: b.provider,
        name: b.name,
        hint: b.secret.slice(-4),
        createdAt: '2026-10-30T10:00:00Z',
      };
      creds.push(row);
      return [
        201,
        {
          ...row,
          check: {
            apiRestricted: true,
            ipRestricted: null,
            valid: true,
            warnings: ['restrict it'],
          },
        },
      ];
    };
    routes['POST /v1/keys'] = () => [
      201,
      {
        id: 'key_1',
        name: 'web',
        prefix: 'sb_live_abcd',
        status: 'active',
        token: 'sb_live_secret123',
        config: {},
      },
    ];
    window.location.hash = '/setup';
    signedInByEmail();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Get started' });

    await user.type(screen.getByLabelText(/Your Google Maps Platform API key/), 'AIzaRealKey1234');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url === '/v1/providers/credentials')!.body,
      ).toEqual({
        provider: 'google-maps',
        name: 'Google Maps Platform',
        secret: 'AIzaRealKey1234',
      }),
    );

    // The step is done, and the advice names the proxy's address and stays on screen.
    expect(await screen.findByText(/Connected: google-maps/)).toBeTruthy();
    expect(screen.getByText('203.0.113.7')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Credentials/ }).getAttribute('href')).toBe(
      'https://console.cloud.google.com/apis/credentials',
    );
    // The key already has API restrictions: no step for them.
    expect(screen.queryByText(/API restrictions/)).toBeNull();

    await user.type(await screen.findByLabelText('Name'), 'web');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('sb_live_secret123')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/keys')!.body).toEqual({
      name: 'web',
      credentials: { 'google-maps': 'cred_1' },
    });
    expect(screen.getByText('https://proxy.example.com/google-maps')).toBeTruthy();
    expect(screen.getByText('https://maps.googleapis.com')).toBeTruthy();
  });

  it('points new orgs from the overview to the setup steps', async () => {
    signedInByEmail();
    expect(await screen.findByRole('link', { name: 'Get started' })).toBeTruthy();
  });
});

describe('telemetry', () => {
  it('gives Prometheus a ready config with a read-only token', async () => {
    routes['GET /v1/telemetry/otlp'] = () => [200, { otlp: null }];
    routes['POST /v1/tokens'] = () => [201, { id: 'tok_p', token: 'sbt_promtoken' }];
    window.location.hash = '/telemetry';
    signedInByEmail();
    const user = userEvent.setup();
    expect(await screen.findByText(/metrics_path: \/v1\/metrics/)).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Create a read-only token for Prometheus' }),
    );
    expect(await screen.findByText(/credentials: sbt_promtoken/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/v1/tokens')!.body).toEqual({
      name: 'prometheus',
      role: 'viewer',
    });
  });

  it('saves an OTLP destination with headers, then sends a test span', async () => {
    let saved: Record<string, unknown> | null = null;
    routes['GET /v1/telemetry/otlp'] = () => [
      200,
      {
        otlp: saved && {
          endpoint: saved.endpoint,
          headerNames: Object.keys(saved.headers as object),
          enabled: true,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastError: null,
          queued: 0,
        },
      },
    ];
    routes['PUT /v1/telemetry/otlp'] = (c) => {
      saved = c.body as Record<string, unknown>;
      return [200, {}];
    };
    routes['POST /v1/telemetry/otlp/test'] = () => [200, { ok: true, status: 200, error: null }];
    window.location.hash = '/telemetry';
    signedInByEmail();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('OTLP/HTTP endpoint'), 'https://api.honeycomb.io');
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    await user.type(screen.getByLabelText('Header'), 'x-honeycomb-team');
    await user.type(screen.getByLabelText('Value'), 'hc-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual({
        endpoint: 'https://api.honeycomb.io',
        headers: { 'x-honeycomb-team': 'hc-secret' },
      }),
    );
    expect(await screen.findByText(/with x-honeycomb-team/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send test span' }));
    expect(await screen.findByText(/Delivered/)).toBeTruthy();
  });

  it('says when the plan does not include OpenTelemetry export', async () => {
    routes['GET /v1/telemetry/otlp'] = () => [200, { otlp: null }];
    routes['PUT /v1/telemetry/otlp'] = () => [
      402,
      {
        error: 'plan_feature',
        message: 'OpenTelemetry export comes with the Team and Agents plans.',
      },
    ];
    window.location.hash = '/telemetry';
    signedInByEmail();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('OTLP/HTTP endpoint'), 'https://api.honeycomb.io');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/comes with the Team and Agents plans/)).toBeTruthy();
  });
});
