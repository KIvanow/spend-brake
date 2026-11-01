// Create (once) the Stripe webhook endpoint billing listens on, test or live mode:
//   STRIPE_SECRET_KEY=sk_test_... pnpm --filter @spend-brake/billing webhook-setup
//   STRIPE_SECRET_KEY=rk_live_... BRAKE_STRIPE_ALLOW_LIVE=1 pnpm --filter @spend-brake/billing webhook-setup
// The endpoint is $BRAKE_DASHBOARD_URL/v1/billing/webhook (default https://app.spendbrake.dev):
// Caddy sends the app domain to the dashboard's nginx, which passes /v1/billing/ to billing.
// Running it again changes nothing but the endpoint's events and URL, brought back in line.
// The signing secret is shown only when the endpoint is created; --recreate deletes the endpoint
// and creates it again (a new secret), e.g. when the secret is lost or the API version moved.
import Stripe from 'stripe';
import { dashboardFromEnv, stripeFromEnv } from './stripe.js';
import { HANDLED_EVENTS } from './webhooks.js';

export const WEBHOOK_METADATA = 'spend_brake_webhook';
/** The API version this SDK speaks: event payloads must have the shape the code reads. */
export const API_VERSION = Stripe.API_VERSION;

export interface WebhookSetupResult {
  id: string;
  url: string;
  /** Only when the endpoint was created in this run: Stripe never shows it again. */
  secret: string | null;
  action: 'created' | 'updated' | 'unchanged' | 'recreated';
  /** Set when the existing endpoint's API version is not the pinned one. */
  apiVersionMismatch: string | null;
}

export const webhookUrl = (dashboardUrl: string) =>
  `${dashboardUrl.replace(/\/$/, '')}/v1/billing/webhook`;

export async function setupWebhook(
  stripe: Pick<Stripe, 'webhookEndpoints'>,
  opts: { url: string; recreate?: boolean },
): Promise<WebhookSetupResult> {
  const events = [...HANDLED_EVENTS].sort();
  let existing: Stripe.WebhookEndpoint | null = null;
  for await (const e of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (e.metadata?.[WEBHOOK_METADATA] === '1' || e.url === opts.url) {
      existing = e;
      break;
    }
  }
  const create = async () =>
    stripe.webhookEndpoints.create({
      url: opts.url,
      enabled_events: events,
      api_version: API_VERSION,
      description: 'Spend Brake hosted billing',
      metadata: { [WEBHOOK_METADATA]: '1' },
    });

  if (existing && opts.recreate) {
    await stripe.webhookEndpoints.del(existing.id);
    const e = await create();
    return {
      id: e.id,
      url: e.url,
      secret: e.secret ?? null,
      action: 'recreated',
      apiVersionMismatch: null,
    };
  }
  if (!existing) {
    const e = await create();
    return {
      id: e.id,
      url: e.url,
      secret: e.secret ?? null,
      action: 'created',
      apiVersionMismatch: null,
    };
  }
  const same =
    existing.url === opts.url &&
    existing.status === 'enabled' &&
    existing.metadata?.[WEBHOOK_METADATA] === '1' &&
    JSON.stringify([...existing.enabled_events].sort()) === JSON.stringify(events);
  if (!same) {
    await stripe.webhookEndpoints.update(existing.id, {
      url: opts.url,
      enabled_events: events,
      disabled: false,
      metadata: { [WEBHOOK_METADATA]: '1' },
    });
  }
  return {
    id: existing.id,
    url: opts.url,
    secret: null,
    action: same ? 'unchanged' : 'updated',
    // The API version of an endpoint is fixed at creation.
    apiVersionMismatch:
      existing.api_version && existing.api_version !== API_VERSION ? existing.api_version : null,
  };
}

/** What the operator reads after a run. */
export function webhookReport(r: WebhookSetupResult, live: boolean): string {
  const lines = [
    `Stripe ${live ? 'LIVE' : 'test'} mode`,
    `Webhook endpoint ${r.id} (${r.action})`,
    `  URL:         ${r.url}`,
    `  API version: ${API_VERSION}`,
    `  Events:      ${[...HANDLED_EVENTS].sort().join(', ')}`,
    '',
  ];
  if (r.secret) {
    lines.push(
      'Signing secret (shown once, Stripe will not show it again):',
      '',
      `  ${r.secret}`,
      '',
      'Put it in infra/.env on the server as',
      `  STRIPE_WEBHOOK_SECRET=${r.secret}`,
      'and restart billing. Do not keep it anywhere else.',
    );
  } else {
    lines.push(
      'The signing secret was shown when the endpoint was created and is not shown again.',
      'STRIPE_WEBHOOK_SECRET in infra/.env must be that secret. Lost it? Roll it in the Stripe',
      'dashboard (Developers > Webhooks > the endpoint > Roll secret), or run this again with',
      '--recreate for a new endpoint and secret.',
    );
  }
  if (r.apiVersionMismatch) {
    lines.push(
      '',
      `WARNING: the endpoint uses API version ${r.apiVersionMismatch}, not ${API_VERSION}.`,
      'Run again with --recreate (new secret) so events have the shape billing expects.',
    );
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A live key only with BRAKE_STRIPE_ALLOW_LIVE=1.
  const { stripe, live } = stripeFromEnv();
  const r = await setupWebhook(stripe, {
    url: webhookUrl(dashboardFromEnv()),
    recreate: process.argv.includes('--recreate'),
  });
  process.stdout.write(webhookReport(r, live));
}
