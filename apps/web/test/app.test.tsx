import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { getToken, setToken, takeSsoToken, toMicros, usd } from '../src/api.js';

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

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
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

let calls: Call[];
let routes: Record<string, (c: Call) => [number, unknown]>;

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  window.localStorage.clear();
  window.location.hash = '';
  routes = {
    'GET /v1/org': (c) =>
      c.auth === 'Bearer sbt_good' ? [200, { id: 'acme' }] : [401, { message: 'bad token' }],
    'GET /v1/auth/session': () => [200, { orgId: 'acme', role: 'owner', actor: 'token:t1' }],
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
  await user.type(await screen.findByLabelText('Admin API token'), 'sbt_good');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Live budget' });
  return user;
}

describe('single sign-on', () => {
  it('keeps a token from the fragment and clears it from the address bar', () => {
    setToken(null);
    const token = `sbt_${'A'.repeat(32)}`;
    window.history.replaceState(null, '', `/#sso_token=${token}`);
    expect(takeSsoToken()).toBe(true);
    expect(getToken()).toBe(token);
    expect(window.location.hash).toBe('#/');
    window.history.replaceState(null, '', '/#sso_token=not-a-token');
    expect(takeSsoToken()).toBe(false);
    setToken(null);
  });
});

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
    await user.type(await screen.findByLabelText('Admin API token'), 'sbt_bad');
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
    // Only the sign-in check and the public sign-in options go without the token.
    expect(
      calls.every(
        (c) => c.auth === 'Bearer sbt_good' || c.url === '/v1/org' || c.url === '/v1/auth/options',
      ),
    ).toBe(true);
  });

  it('edits caps in exact micros and rejects malformed amounts', async () => {
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Caps' }));
    await screen.findByRole('heading', { name: 'Caps', level: 2 });
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

  it("keeps a scope's hard cap when only the soft limit changes, and says why a save failed", async () => {
    routes['PUT /v1/caps/org'] = () => [
      400,
      {
        error: 'invalid_request',
        message: 'Request failed validation.',
        issues: [
          {
            in: 'body',
            path: 'day',
            message: 'The soft cap (alert) must not be above the hard cap.',
          },
        ],
      },
    ];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Caps' }));
    const form = await screen.findByRole('form', { name: 'Set a cap' });
    // The org's daily cap is $5: the form starts from it.
    await waitFor(() =>
      expect(within(form).getByLabelText<HTMLInputElement>('Hard cap ($)').value).toBe('5'),
    );
    await user.type(within(form).getByLabelText('Soft limit ($)'), '6');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The soft cap (alert) must not be above the hard cap.'),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      day: { hard: 5_000_000, soft: 6_000_000 },
    });
  });

  it('says when a raise waits for approval, and lets a second person approve it', async () => {
    routes['PUT /v1/caps/org'] = () => [
      200,
      { items: [], pending: [{ scope: 'org', kind: 'd', approvalId: 'apr_1' }] },
    ];
    let pending = true;
    routes['GET /v1/approvals'] = () => [
      200,
      {
        items: pending
          ? [
              {
                id: 'apr_1',
                subject: 'cap',
                scope: 'org',
                kind: 'd',
                fromHard: 5_000_000,
                toHard: 9_000_000,
                remove: false,
                status: 'pending',
                requestedBy: 'user:usr_ana',
                requestedAt: '2026-10-30T12:00:00Z',
              },
            ]
          : [],
      },
    ];
    routes['POST /v1/approvals/apr_1/approve'] = () => {
      pending = false;
      return [200, { id: 'apr_1', status: 'approved' }];
    };
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Caps' }));
    const form = screen.getByRole('form', { name: 'Set a cap' });
    await user.type(within(form).getByLabelText('Hard cap ($)'), '9');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Waiting for a second person/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Approvals' }));
    expect(await screen.findByText('org per day: $5.00 → $9.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Nothing is waiting.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/approvals/apr_1/approve')).toBe(true);
  });

  it('shows the hosted plan against its limits and starts Checkout', async () => {
    routes['GET /v1/billing'] = () => [
      200,
      {
        plan: 'free',
        planName: 'Free',
        status: 'past_due',
        currentPeriodEnd: null,
        hasSubscription: false,
        limits: {
          maxKeys: 1,
          maxProviders: 1,
          agentSessionsPerMonth: 20,
          requestsPerMonth: 10_000,
          maxOrgMonthCapMicros: 50_000_000,
          retentionDays: 7,
        },
        usage: { keys: 1, providers: 1, agentSessionsThisMonth: 3, requestsThisMonth: 1234 },
        plans: [{ id: 'indie', name: 'Indie' }],
        licenses: [],
      },
    ];
    routes['POST /v1/billing/checkout'] = () => [200, { url: 'about:blank' }];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    expect(await screen.findByText('1,234 of 10,000')).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.getByText(/A payment failed/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Buy Indie' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/billing/checkout')).toMatchObject({
        method: 'POST',
        body: { plan: 'indie' },
      }),
    );
  });

  it('tells admins that owners manage billing, without buy buttons', async () => {
    routes['GET /v1/auth/session'] = () => [200, { orgId: 'acme', role: 'admin', actor: 'u' }];
    routes['GET /v1/billing'] = () => [
      200,
      {
        plan: 'free',
        planName: 'Free',
        status: 'active',
        currentPeriodEnd: null,
        hasSubscription: false,
        limits: null,
        usage: { keys: 0, providers: 0, agentSessionsThisMonth: 0, requestsThisMonth: 0 },
        plans: [{ id: 'indie', name: 'Indie' }],
        licenses: [],
      },
    ];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    expect(await screen.findByText('Owners manage billing.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buy Indie' })).toBeNull();
  });

  it('says billing is not part of a self-hosted install', async () => {
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    expect(await screen.findByText(/a self-hosted install has no plan/)).toBeTruthy();
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

  it('folds the pages into a Menu button that names the page and works from the keyboard', async () => {
    const user = await signIn();
    expect(document.title).toBe('Overview · Spend Brake');
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const menu = screen.getByRole('button', { name: 'Menu, current page: Overview' });
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(nav.className).not.toContain('open');

    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(nav.className).toContain('open');
    // Focus moves onto the current page; Escape closes and returns to the button.
    expect(document.activeElement?.textContent).toBe('Overview');
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);

    await user.keyboard('{Enter}');
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await user.click(within(nav).getByRole('button', { name: 'Caps' }));
    expect(await screen.findByRole('heading', { name: 'Caps', level: 2 })).toBeTruthy();
    expect(nav.className).not.toContain('open');
    expect(screen.getByRole('button', { name: 'Menu, current page: Caps' })).toBeTruthy();
    expect(document.title).toBe('Caps · Spend Brake');
    // Focus lands on the new page's heading, not on <body>.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Caps' }));

    // Tabbing out of the open list (to Sign out) closes it.
    await user.click(screen.getByRole('button', { name: 'Menu, current page: Caps' }));
    expect(nav.className).toContain('open');
    screen.getByRole('button', { name: 'Sign out' }).focus();
    await waitFor(() => expect(nav.className).not.toContain('open'));

    // The skip link jumps past the header to the page.
    await user.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Caps' }));
    expect(window.location.hash).toBe('#/caps');
    window.location.hash = '';
  });

  it('exports the events shown as CSV through a blob download', async () => {
    routes['GET /v1/events'] = () => [200, { items: [], nextCursor: null }];
    routes['GET /v1/keys'] = () => [200, { items: [] }];
    const json = globalThis.fetch;
    const csvCalls: { url: string; auth: string | undefined }[] = [];
    let truncated = 'false';
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
      if (!String(input).startsWith('/v1/events.csv')) return json(input, init);
      csvCalls.push({
        url: String(input),
        auth: (init.headers as Record<string, string> | undefined)?.authorization,
      });
      return Promise.resolve(
        new Response('time_utc,type\r\n', {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="spend-brake-audit-2026-10-31.csv"',
            'x-brake-truncated': truncated,
          },
        }),
      );
    });
    const created: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        created.push(b);
        return 'blob:test/1';
      },
      revokeObjectURL: () => undefined,
    });
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Events' }));
    await user.click(await screen.findByRole('tab', { name: 'Audit log' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/Exported every audit log entry/)).toBeTruthy();
    expect(csvCalls).toEqual([{ url: '/v1/events.csv?source=audit', auth: 'Bearer sbt_good' }]);
    expect(await created[0]!.text()).toBe('time_utc,type\r\n');
    expect(clicked[0]!.href).toBe('blob:test/1');
    expect(clicked[0]!.download).toBe('spend-brake-audit-2026-10-31.csv');

    truncated = 'true';
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/newest 100,000 rows/)).toBeTruthy();
    click.mockRestore();
  });

  it('notes an org monthly hard cap on Billing, with a link to Caps', async () => {
    routes['GET /v1/billing'] = () => [
      200,
      {
        plan: 'team',
        planName: 'Team',
        status: 'active',
        currentPeriodEnd: null,
        hasSubscription: true,
        limits: null,
        usage: { keys: 0, providers: 0, agentSessionsThisMonth: 0, requestsThisMonth: 0 },
        plans: [],
        licenses: [],
      },
    ];
    routes['GET /v1/caps'] = () => [
      200,
      { items: [{ scope: 'org', kind: 'm', hard: 50_000_000, soft: null, version: 1 }] },
    ];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe(
      "Your org has a $50/month hard cap (set at sign-up). Calls stop when it's reached. Change it on Caps.",
    );
    expect(within(note).getByRole('link', { name: 'Caps' }).getAttribute('href')).toBe('#/caps');
  });

  it('charts spend and totals the period', async () => {
    routes['GET /v1/reconciliation'] = () => [
      200,
      { configured: false, message: 'Spend is measured by the proxy only.', lastError: null },
    ];
    routes['GET /v1/keys'] = () => [
      200,
      { items: [{ id: 'k1', name: 'web app', status: 'active' }] },
    ];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Spend' }));
    expect(await screen.findByText('$0.04')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    expect(await screen.findByText('$0.0420')).toBeTruthy();
    // Keys by name, not id.
    expect((await screen.findByText('web app')).getAttribute('title')).toBe('k1');
    expect(await screen.findByText('Spend is measured by the proxy only.')).toBeTruthy();
  });

  it('shows billing drift when an export is connected', async () => {
    routes['GET /v1/reconciliation'] = () => [
      200,
      { configured: true, message: 'Compared daily.', lastError: null },
    ];
    routes['GET /v1/reconciliation/report'] = () => [
      200,
      {
        items: [
          {
            day: '2026-10-28',
            family: 'total',
            ledgerMicros: 1_000_000,
            billedMicros: 1_100_000,
            driftRatio: 0.0909,
          },
        ],
      },
    ];
    const user = await signIn();
    await user.click(screen.getByRole('button', { name: 'Spend' }));
    expect(await screen.findByText('9.1%')).toBeTruthy();
    expect(screen.getByText('9.1%').className).toContain('danger');
  });

  it('leaves the bill comparison out on the hosted service, without asking for it', async () => {
    routes['GET /v1/auth/options'] = () => [
      200,
      { emailSignIn: true, signup: true, proxyUrl: null, egressIps: [] },
    ];
    window.location.hash = '#/spend';
    sessionStorage.setItem('brake.adminToken', 'sbt_good');
    render(<App client={client()} />);
    expect(await screen.findByText('$0.0420')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/auth/options')).toBe(true));
    expect(screen.queryByRole('heading', { name: "Compared with Google's bill" })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/v1/reconciliation'))).toBe(false);
    window.location.hash = '';
  });

  it('does not ask again for a bill comparison the edition lacks', async () => {
    routes['GET /v1/auth/options'] = () => [
      200,
      { emailSignIn: false, signup: false, proxyUrl: null, egressIps: [] },
    ];
    window.location.hash = '#/spend';
    sessionStorage.setItem('brake.adminToken', 'sbt_good');
    // A client that retries failed queries, as the app's own does.
    render(<App client={new QueryClient()} />);
    expect(await screen.findByText(/part of the Business and Enterprise editions/)).toBeTruthy();
    expect(calls.filter((c) => c.url === '/v1/reconciliation')).toHaveLength(1);
    window.location.hash = '';
  });
});
