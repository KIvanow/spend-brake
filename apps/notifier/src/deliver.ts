import { isIP } from 'node:net';
import {
  type GuardedClient,
  WEBHOOK_SIGNATURE_HEADER,
  isPrivateAddress,
  WEBHOOK_TIMESTAMP_HEADER,
  redactText,
  signWebhook,
} from '@spend-brake/shared';
import { request } from 'undici';

export { isPrivateAddress, guardedAgent } from '@spend-brake/shared';
export type WebhookClient = GuardedClient;

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** POST a signed JSON body; 2xx is success. Never follows redirects. */
export async function postWebhook(
  url: string,
  secret: string,
  payload: unknown,
  opts: { dispatcher: WebhookClient; timeoutMs?: number; nowSec?: number },
): Promise<DeliveryResult> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host) && !opts.dispatcher.allowPrivate) {
    return { ok: false, status: null, error: `webhook host is a private address (${host})` };
  }
  const body = JSON.stringify(payload);
  const ts = opts.nowSec ?? Math.floor(Date.now() / 1000);
  try {
    const res = await request(url, {
      method: 'POST',
      body,
      dispatcher: opts.dispatcher.agent,
      headersTimeout: opts.timeoutMs ?? 10_000,
      bodyTimeout: opts.timeoutMs ?? 10_000,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'spend-brake-notifier',
        [WEBHOOK_TIMESTAMP_HEADER]: String(ts),
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, ts, body),
      },
    });
    await res.body.dump();
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return { ok, status: res.statusCode, error: ok ? null : `HTTP ${res.statusCode}` };
  } catch (err) {
    // Webhook URLs are credentials (Slack, Teams): never let one into the delivery log.
    return {
      ok: false,
      status: null,
      error: redactText((err as Error).message, [url]).slice(0, 500),
    };
  }
}
