import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CliError, EXIT, type Io } from '../io.js';
import { proxyCall, report } from '../proxy.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Any capped request through the proxy, for providers without dedicated commands. */
export function callCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('call')
    .description('Any capped request: brake call <provider> <method> <path>')
    .argument(
      '<provider>',
      'proxy prefix, e.g. google-maps, google-places, google-routes, or a generic provider',
    )
    .argument('<method>')
    .argument('<path>', 'path on the provider, e.g. /maps/api/geocode/json')
    .option('-d, --data <json>', 'JSON body; @file reads a file')
    .option('-q, --query <k=v...>', 'query parameters')
    .option('-H, --header <k:v...>', 'extra headers (X-Brake-* are ignored by the proxy)')
    .option('--pretty', 'human-readable output instead of JSON')
    .action(
      async (
        provider: string,
        method: string,
        path: string,
        o: { data?: string; query?: string[]; header?: string[] },
        cmd: Command,
      ) => {
        const m = method.toUpperCase();
        if (!METHODS.has(m)) throw new CliError(`unknown method ${method}`, EXIT.usage);
        if (!/^[A-Za-z0-9_.-]+$/.test(provider)) throw new CliError('invalid provider', EXIT.usage);
        if (!path.startsWith('/')) throw new CliError('path must start with /', EXIT.usage);
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
          headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
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
        const result = await proxyCall(io, {
          method: m,
          path: `/${provider}${path}`,
          query,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        done(report(io, result, Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty)));
      },
    );
}
