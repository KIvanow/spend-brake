// Product analytics (PostHog), only where the install sets BRAKE_POSTHOG_KEY on the API: the
// key arrives with GET /v1/auth/options. Without it posthog-js is never even loaded and nothing
// is sent. With it: nothing stored in the browser (memory only), no autocapture, no session
// recordings or surveys; page views carry the route name only (sign-in links put codes and
// tokens in the hash), people are known by their internal user id, never an email or name.
import type { CaptureResult, PostHog, Properties } from 'posthog-js';

export interface AnalyticsConfig {
  key: string;
  host: string;
}

/** The product events, with the only properties each may carry. */
export interface Events {
  signed_up: { plan: string };
  provider_key_added: { provider: string };
  key_created: Record<string, never>;
  cap_set: { scope: string };
  custom_api_created: Record<string, never>;
  checkout_started: { plan: string };
  csv_exported: { source: string };
}

type Load = () => Promise<{ default: PostHog }>;
// The bundle that never loads scripts from elsewhere: the dashboard's CSP allows none.
const loadPosthog: Load = () => import('posthog-js/no-external');

let posthog: PostHog | null = null;
// Calls made while posthog-js loads; null when analytics are off (calls are dropped).
let waiting: ((ph: PostHog) => void)[] | null = null;
let lastRoute: string | null = null;

function run(fn: (ph: PostHog) => void): void {
  if (posthog) fn(posthog);
  else waiting?.push(fn);
}

/** `#/caps`, `#/signup?plan=team` → `/caps`, `/signup`; anything else (`#login=…`) → `/`. */
export function safeRoute(hash: string): string {
  const m = /^#\/([A-Za-z-]{1,30})(?:[/?].*)?$/.exec(hash);
  return m ? `/${m[1]!.toLowerCase()}` : '/';
}

/** A URL with its fragment replaced by the route name, and no query string. */
function safeUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}${u.hash ? `#${safeRoute(u.hash)}` : ''}`;
  } catch {
    return null;
  }
}

/** Where someone came from, as an origin only (a Stripe or mail URL can carry ids). */
function safeReferrer(value: unknown): unknown {
  if (typeof value !== 'string' || value === '$direct') return value;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function scrub(props: Properties | undefined): void {
  if (!props) return;
  for (const name of Object.keys(props)) {
    if (/_url$/.test(name)) props[name] = safeUrl(props[name]);
    else if (/referrer$/.test(name)) props[name] = safeReferrer(props[name]);
    else if (/^(\$initial_)?(utm_|gclid|fbclid|msclkid)/.test(name)) delete props[name];
  }
}

/** The last check on every event: URLs, referrers and person properties lose anything secret. */
export function sanitize(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  scrub(event.properties);
  scrub(event.properties.$set as Properties | undefined);
  scrub(event.properties.$set_once as Properties | undefined);
  scrub(event.$set);
  scrub(event.$set_once);
  return event;
}

/** Turn analytics on when the install configured them; otherwise do nothing, ever. */
export async function startAnalytics(
  config: AnalyticsConfig | null | undefined,
  load: Load = loadPosthog,
): Promise<void> {
  if (!config?.key || posthog || waiting) return;
  waiting = [];
  try {
    const { default: ph } = await load();
    ph.init(config.key, {
      api_host: config.host,
      persistence: 'memory',
      autocapture: false,
      rageclick: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      person_profiles: 'identified_only',
      // Memory only means a new anonymous id on every load: don't merge each one into the person.
      reuseAnonymousId: true,
      before_send: sanitize,
    });
    posthog = ph;
    for (const fn of waiting) fn(ph);
    waiting = null;
    pageview();
    window.addEventListener('hashchange', pageview);
  } catch {
    // Blocked or failed to load: the dashboard works the same without it.
    waiting = null;
  }
}

/** A page view for the current route (its name only); a repeat of the same route is skipped. */
export function pageview(): void {
  const route = safeRoute(window.location.hash);
  if (!posthog || route === lastRoute) return;
  lastRoute = route;
  posthog.capture('$pageview', { route });
}

/** A product event that just succeeded. */
export function track<E extends keyof Events>(event: E, props: Events[E]): void {
  // Sent at once: several of these are followed by leaving the page (Stripe Checkout).
  run((ph) => ph.capture(event, props, { send_instantly: true, transport: 'sendBeacon' }));
}

/** The signed-in person: `user:<id>` is identified by that id; an API token stays anonymous. */
export function identify(session: { actor: string; orgId: string }): void {
  const user = /^user:(.+)$/.exec(session.actor)?.[1];
  run((ph) => {
    if (user && ph.get_distinct_id() !== user) ph.identify(user);
    ph.group('org', session.orgId);
  });
}

/** Signed out: forget who it was. */
export function resetAnalytics(): void {
  run((ph) => ph.reset());
  lastRoute = null;
}

/** Tests only: back to the state before startAnalytics. */
export function stopAnalytics(): void {
  window.removeEventListener('hashchange', pageview);
  posthog = null;
  waiting = null;
  lastRoute = null;
}
