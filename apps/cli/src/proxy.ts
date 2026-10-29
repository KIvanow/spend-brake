import { CliError, EXIT, type Io, config, microsToUsd } from './io.js';

export interface ProxyRequest {
  method: string;
  /** Path under the proxy, including the provider prefix: `/google-maps/maps/api/...`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  costMicros: number | null;
  cost: string | null;
  remainingMicros: number | null;
  requestId: string | null;
  data: unknown;
}

const num = (v: string | null) => (v === null || v === '' ? null : Number(v));

/** Send one capped request through the proxy with the virtual key (and session, if any). */
export async function proxyCall(io: Io, req: ProxyRequest): Promise<ProxyResult> {
  const cfg = config(io);
  if (!cfg.key)
    throw new CliError(
      'BRAKE_KEY is not set (run inside `brake session` or export it).',
      EXIT.auth,
    );
  const url = new URL(`${cfg.proxyUrl}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  // The key and session always come from the environment, never from user-supplied headers.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (!k.toLowerCase().startsWith('x-brake-')) headers[k] = v;
  }
  headers['x-brake-key'] = cfg.key;
  if (cfg.session) headers['x-brake-session'] = cfg.session;
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    headers['content-type'] ??= 'application/json';
  }
  let res: Response;
  try {
    res = await io.fetch(url, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch (err) {
    throw new CliError(`cannot reach the proxy at ${cfg.proxyUrl}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    // not JSON: keep the text
  }
  const cost = num(res.headers.get('x-brake-cost-micros'));
  return {
    ok: res.ok,
    status: res.status,
    costMicros: cost,
    cost: cost === null ? null : microsToUsd(cost),
    remainingMicros: num(res.headers.get('x-brake-remaining-micros')),
    requestId: res.headers.get('x-brake-request-id'),
    data,
  };
}

interface BrakeErrorBody {
  error?: string;
  message?: string;
  scope?: string;
  cap?: number;
  retryAfter?: number;
  target?: string;
}

/**
 * Print a result (JSON by default) and work out the exit code. Proxy refusals get a one-line
 * reason on stderr that tells an agent to stop rather than retry.
 */
export function report(io: Io, r: ProxyResult, pretty: boolean): number {
  if (pretty) {
    const parts = [`HTTP ${r.status}`];
    if (r.cost !== null) parts.push(`cost ${r.cost}`);
    if (r.remainingMicros !== null) parts.push(`remaining ${microsToUsd(r.remainingMicros, 2)}`);
    io.stdout(`${parts.join(' · ')}\n${JSON.stringify(r.data, null, 2)}\n`);
  } else {
    io.stdout(`${JSON.stringify(r)}\n`);
  }
  if (r.ok) return EXIT.ok;
  const e = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as BrakeErrorBody;
  switch (e.error) {
    case 'budget_exceeded':
      io.stderr(
        `brake: STOP. Spend cap reached for ${e.scope ?? 'this key'}${e.cap !== undefined ? ` (cap ${microsToUsd(e.cap, 2)})` : ''}. Do not retry; ask the user to raise the cap.\n`,
      );
      return EXIT.budget;
    case 'killed':
      io.stderr(
        `brake: STOP. Spending is switched off for ${e.target ?? 'this key'}. Ask the user.\n`,
      );
      return EXIT.budget;
    case 'unpriced_route':
      io.stderr('brake: STOP. This route has no known price, so it is blocked. Ask the user.\n');
      return EXIT.budget;
    case 'loop_detected':
      io.stderr(
        `brake: STOP. Repeated identical requests; the key is paused${e.retryAfter ? ` for ${e.retryAfter} s` : ''}. Do not retry; ask the user.\n`,
      );
      return EXIT.loop;
    case 'invalid_key':
      io.stderr(`brake: ${e.message ?? 'invalid virtual key'}\n`);
      return EXIT.auth;
    default:
      io.stderr(
        `brake: request failed with HTTP ${r.status}${e.message ? `: ${e.message}` : ''}\n`,
      );
      return EXIT.error;
  }
}
