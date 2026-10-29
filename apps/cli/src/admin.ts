import { CliError, EXIT, type Io, config, microsToUsd } from './io.js';

/** Call the admin API with the admin token (env or `brake init` config). */
export async function apiCall<T = unknown>(
  io: Io,
  method: string,
  path: string,
  body?: unknown,
  auth: Record<string, string> | null = null,
): Promise<T> {
  const cfg = config(io);
  const headers: Record<string, string> = auth ?? {};
  if (!auth) {
    if (!cfg.adminToken) {
      throw new CliError('No admin token: run `brake init` or set BRAKE_ADMIN_TOKEN.', EXIT.auth);
    }
    headers.authorization = `Bearer ${cfg.adminToken}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await io.fetch(`${cfg.apiUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new CliError(`cannot reach the admin API at ${cfg.apiUrl}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    // keep text
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new CliError(msg, res.status === 401 ? EXIT.auth : EXIT.error);
  }
  return data as T;
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
};

/** JSON by default; with --pretty a plain table of the given columns. */
export function print(
  io: Io,
  data: unknown,
  pretty: boolean,
  rows?: Record<string, unknown>[],
  columns?: string[],
) {
  if (!pretty || !rows || !columns) {
    io.stdout(`${JSON.stringify(data, null, pretty ? 2 : undefined)}\n`);
    return;
  }
  const cells = rows.map((r) => columns.map((c) => cell(r[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  io.stdout(`${[line(columns), ...cells.map(line)].join('\n')}\n`);
}

export const money = (v: unknown, decimals = 2) =>
  v === null || v === undefined ? '' : microsToUsd(BigInt(v as number), decimals);
