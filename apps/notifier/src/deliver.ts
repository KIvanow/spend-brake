import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  redactText,
  signWebhook,
} from '@spend-brake/shared';
import { Agent, request } from 'undici';

/** Loopback, private, link-local (incl. cloud metadata), CGNAT and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const x = ip.toLowerCase();
  return (
    x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')
  );
}

export interface WebhookClient {
  agent: Agent;
  allowPrivate: boolean;
}

/**
 * An HTTP client that refuses private addresses: hostnames are checked in the DNS lookup, on
 * the address actually connected to (no rebinding window), and IP literals before connecting.
 */
export function guardedAgent(allowPrivate: boolean): WebhookClient {
  return { allowPrivate, agent: lookupGuardedAgent(allowPrivate) };
}

function lookupGuardedAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, cb) {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return cb(err, '', 0);
          const list = addresses as { address: string; family: number }[];
          const bad = list.find((a) => isPrivateAddress(a.address));
          if (bad && !allowPrivate) {
            return cb(
              new Error(`webhook host resolves to a private address (${bad.address})`),
              '',
              0,
            );
          }
          const first = list[0]!;
          if ((options as { all?: boolean }).all)
            return (cb as (e: null, a: typeof list) => void)(null, list);
          return cb(null, first.address, first.family);
        });
      },
    },
  });
}

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
