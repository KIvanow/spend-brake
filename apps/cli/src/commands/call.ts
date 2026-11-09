import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CliError, EXIT, type Io } from '../io.js';
import { type ProxyRequest, proxyCall, report } from '../proxy.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface CallInput {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** A JSON value, or a JSON string (the CLI passes the text of `-d`). */
  body?: unknown;
}

/**
 * The request `brake call` sends. `X-Brake-*` headers are dropped: the key comes from
 * `BRAKE_KEY`. An invalid provider, method or path throws.
 */
export function callRequest(
  provider: string,
  method: string,
  path: string,
  o: CallInput = {},
): ProxyRequest {
  const m = method.toUpperCase();
  if (!METHODS.has(m)) throw new CliError(`unknown method ${method}`, EXIT.usage);
  // Custom APIs live under /custom/<id>/ on the proxy.
  if (!/^(custom\/)?[A-Za-z0-9_.-]+$/.test(provider) || /(^|\/)\.\.?$/.test(provider)) {
    throw new CliError('invalid provider', EXIT.usage);
  }
  if (!path.startsWith('/')) throw new CliError('path must start with /', EXIT.usage);
  // URL parsing resolves `.` and `..` (also encoded, or after `\`): the request would leave the
  // provider's prefix, and be priced as another provider's route.
  const segments = path.split(/[/\\]/).map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  if (path.includes('\\') || segments.some((seg) => seg === '.' || seg === '..')) {
    throw new CliError('path must not contain . or .. segments, or backslashes', EXIT.usage);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const name = k.trim().toLowerCase();
    if (!name) throw new CliError('empty header name', EXIT.usage);
    if (name.startsWith('x-brake-')) continue;
    headers[name] = v;
  }
  return {
    method: m,
    path: `/${provider}${path}`,
    query: o.query ?? {},
    headers,
    ...(o.body !== undefined ? { body: o.body } : {}),
  };
}

/** Any capped request through the proxy, for providers without dedicated commands. */
export function callCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('call')
    .description('Any capped request: brake call <provider> <method> <path>')
    .argument(
      '<provider>',
      'proxy prefix, e.g. google-maps, google-places, google-routes, a generic provider, or custom/<id> for a custom API',
    )
    .argument('<method>')
    .argument('<path>', 'path on the provider, e.g. /maps/api/geocode/json')
    .option('-d, --data <json>', 'JSON body; @file reads a file')
    .option('-q, --query <k=v...>', 'query parameters')
    .option(
      '-H, --header <k:v...>',
      'extra headers (X-Brake-* headers are dropped; the key comes from BRAKE_KEY)',
    )
    .option('--pretty', 'human-readable output instead of JSON')
    .action(
      async (
        provider: string,
        method: string,
        path: string,
        o: { data?: string; query?: string[]; header?: string[] },
        cmd: Command,
      ) => {
        const query: Record<string, string> = {};
        for (const q of o.query ?? []) {
          const i = q.indexOf('=');
          if (i < 1) throw new CliError(`bad --query ${q}`, EXIT.usage);
          query[q.slice(0, i)] = q.slice(i + 1);
        }
        const headers: Record<string, string> = {};
        for (const h of o.header ?? []) {
          const i = h.indexOf(':');
          if (i < 1) throw new CliError(`bad --header ${h}`, EXIT.usage);
          headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
        }
        let body: string | undefined;
        if (o.data !== undefined) {
          body = o.data.startsWith('@') ? readFileSync(o.data.slice(1), 'utf8') : o.data;
          try {
            JSON.parse(body);
          } catch {
            throw new CliError('--data must be JSON', EXIT.usage);
          }
        }
        const result = await proxyCall(
          io,
          callRequest(provider, method, path, {
            query,
            headers,
            ...(body !== undefined ? { body } : {}),
          }),
        );
        done(report(io, result, Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty)));
      },
    );
}
