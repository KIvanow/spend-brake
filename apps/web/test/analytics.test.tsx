import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import {
  identify,
  resetAnalytics,
  safeRoute,
  sanitize,
  startAnalytics,
  stopAnalytics,
  track,
} from '../src/analytics.js';
import { setToken } from '../src/api.js';

// A stand-in for posthog-js: what the dashboard calls on it, and whether it was loaded at all.
const ph = vi.hoisted(() => ({
  loaded: 0,
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  get_distinct_id: () => 'anon',
}));
vi.mock('posthog-js/no-external', () => {
  ph.loaded += 1;
  return { default: ph };
});

const CONFIG = { key: 'phc_test', host: 'https://eu.i.posthog.com' };

beforeEach(() => {
  ph.loaded = 0;
  vi.clearAllMocks();
  ph.get_distinct_id = () => 'anon';
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  stopAnalytics();
  vi.unstubAllGlobals();
  setToken(null);
  window.location.hash = '';
});

describe('analytics, not configured', () => {
  it('never loads posthog-js and sends nothing', async () => {
    const load = vi.fn();
    await startAnalytics(null, load);
    await startAnalytics({ key: '', host: CONFIG.host }, load);
    await startAnalytics(undefined);
    track('key_created', {});
    identify({ actor: 'user:u1', orgId: 'org1' });
    resetAnalytics();
    expect(load).not.toHaveBeenCalled();
    expect(ph.loaded).toBe(0);
    expect(ph.init).not.toHaveBeenCalled();
    expect(ph.capture).not.toHaveBeenCalled();
  });
});

describe('analytics, configured', () => {
  it('keeps nothing in the browser and records nothing automatically', async () => {
    await startAnalytics(CONFIG);
    expect(ph.init).toHaveBeenCalledTimes(1);
    const [key, options] = ph.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toBe('phc_test');
    expect(options).toMatchObject({
      api_host: 'https://eu.i.posthog.com',
      persistence: 'memory',
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      reuseAnonymousId: true,
    });
    expect(options.before_send).toBe(sanitize);
  });

  it('counts page views by route name, never what the hash carries', async () => {
    window.location.hash = '#/caps';
    await startAnalytics(CONFIG);
    expect(ph.capture).toHaveBeenLastCalledWith('$pageview', { route: '/caps' });
    window.location.hash = '#/signup?plan=team';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(ph.capture).toHaveBeenLastCalledWith('$pageview', { route: '/signup' });
    const code = 'a'.repeat(43);
    window.location.hash = `#login=${code}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(ph.capture).toHaveBeenLastCalledWith('$pageview', { route: '/' });
    expect(JSON.stringify(ph.capture.mock.calls)).not.toContain(code);
  });

  it('strips sign-in codes and tokens from routes and URLs', () => {
    expect(safeRoute('#/keys')).toBe('/keys');
    expect(safeRoute('#/Billing/x?y=1')).toBe('/billing');
    expect(safeRoute(`#login=${'b'.repeat(43)}`)).toBe('/');
    expect(safeRoute(`#sso_token=sbt_${'c'.repeat(32)}`)).toBe('/');
    expect(safeRoute(`#/${'d'.repeat(43)}`)).toBe('/');
    expect(safeRoute('')).toBe('/');

    const secret = `sbt_${'e'.repeat(32)}`;
    const event = sanitize({
      uuid: '1',
      event: '$pageview',
      properties: {
        $current_url: `https://app.example.com/?x=1#sso_token=${secret}`,
        $referrer: `https://checkout.stripe.com/c/pay/cs_live_${secret}`,
        $set_once: { $initial_current_url: `https://app.example.com/#login=${secret}` },
        utm_source: secret,
        route: '/',
      },
      $set_once: { $initial_referrer: `https://mail.example.com/read/${secret}` },
    })!;
    expect(event.properties.$current_url).toBe('https://app.example.com/#/');
    expect(event.properties.$referrer).toBe('https://checkout.stripe.com');
    expect(event.$set_once!.$initial_referrer).toBe('https://mail.example.com');
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it('identifies people by their user id only, with their org as a group', async () => {
    await startAnalytics(CONFIG);
    identify({ actor: 'user:u1', orgId: 'org1' });
    expect(ph.identify).toHaveBeenCalledWith('u1');
    expect(ph.identify.mock.calls[0]).toHaveLength(1);
    expect(ph.group).toHaveBeenCalledWith('org', 'org1');
    // A pasted API token is no person: its org only.
    ph.identify.mockClear();
    identify({ actor: 'token:t1', orgId: 'org2' });
    expect(ph.identify).not.toHaveBeenCalled();
    expect(ph.group).toHaveBeenLastCalledWith('org', 'org2');
  });

  it('sends product events with their own properties, queued while posthog-js loads', async () => {
    const started = startAnalytics(CONFIG);
    track('checkout_started', { plan: 'team' });
    await started;
    expect(ph.capture).toHaveBeenCalledWith(
      'checkout_started',
      { plan: 'team' },
      { send_instantly: true, transport: 'sendBeacon' },
    );
  });
});

describe('analytics in the dashboard', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken('sbt_good');
    const routes: Record<string, unknown> = {
      'GET /v1/auth/session': { orgId: 'org1', role: 'owner', actor: 'user:u1' },
      'GET /v1/auth/options': { emailSignIn: false, signup: false, proxyUrl: null, egressIps: [] },
      'GET /v1/status': { killed: [], scopes: [] },
      'GET /v1/keys': { items: [] },
      'DELETE /v1/auth/session': { revoked: true },
    };
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
      const body = routes[`${init.method ?? 'GET'} ${String(input).split('?')[0]}`];
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { message: 'no route' }), {
          status: body ? 200 : 404,
        }),
      );
    });
  });

  it('identifies the signed-in person by id, and forgets them on sign-out', async () => {
    await startAnalytics(CONFIG);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App client={client} />);
    await waitFor(() => expect(ph.identify).toHaveBeenCalledWith('u1'));
    expect(ph.group).toHaveBeenCalledWith('org', 'org1');
    expect(ph.reset).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(ph.reset).toHaveBeenCalledTimes(1);
  });
});
