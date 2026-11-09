import { CliError, EXIT, type Io, config, microsToUsd } from './io.js';

/** A refusal from the admin API, with its HTTP status. */
export class ApiRefusal extends CliError {
  constructor(
    message: string,
    code: number,
    readonly status: number,
    /** The API's error code, such as `forbidden`. */
    readonly error?: string,
  ) {
    super(message, code);
  }
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
  /** Body text before JSON parsing. Audit export and metrics are not JSON. */
  text: string;
}

/** Call the admin API and keep the response headers (audit export sends `X-Next-Cursor`). */
export async function apiExchange<T = unknown>(
  io: Io,
  method: string,
  path: string,
  body?: unknown,
  auth: Record<string, string> | null = null,
): Promise<ApiResponse<T>> {
  const cfg = config(io);
  const headers: Record<string, string> = { ...auth };
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
    // The cause stays attached: a timeout must still read as one (see timedOut).
    throw new CliError(
      `cannot reach the admin API at ${cfg.apiUrl}: ${(err as Error).message}`,
      EXIT.error,
      { cause: err },
    );
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    // keep text
  }
  if (!res.ok) {
    const e = data as { message?: string; error?: string } | null;
    throw new ApiRefusal(
      e?.message ?? `HTTP ${res.status}`,
      res.status === 401 ? EXIT.auth : EXIT.error,
      res.status,
      typeof e?.error === 'string' ? e.error : undefined,
    );
  }
  return { data: data as T, headers: res.headers, text };
}

/** Call the admin API with the admin token (env or `brake init` config). */
export async function apiCall<T = unknown>(
  io: Io,
  method: string,
  path: string,
  body?: unknown,
  auth: Record<string, string> | null = null,
): Promise<T> {
  return (await apiExchange<T>(io, method, path, body, auth)).data;
}

/** GET /v1/me: a virtual key's own view of its caps and policy. */
export interface Me {
  keyId: string;
  sessionId: string | null;
  killed: boolean;
  /** Servers before 0.3.0 do not send it. */
  killedProviders?: string[];
  scopes: {
    scope: string;
    window: string;
    spent: number;
    held: number;
    hard: number | null;
    remaining: number | null;
  }[];
  /** Servers before 0.3.0 do not send it. */
  policy?: {
    providers: string[];
    skus: string[] | null;
    canMintSessions: boolean;
    expiresAt: string | null;
    failOpenMicros: number | null;
    unpriced: Record<string, { policy: string; defaultPriceMicros: number | null }>;
  };
}

export interface Minted {
  sessionId: string;
  keyId: string;
  token: string;
  agentId: string;
  budgetMicros: number;
  dayBudgetMicros: number;
  expiresAt: string;
}

/** Mint a session key, authenticated by the parent key or the admin token in `auth`. */
export const mintSession = (
  io: Io,
  auth: Record<string, string>,
  body: {
    budgetMicros: string;
    dayBudgetMicros: string;
    ttlSec: number;
    agentId?: string;
    parentKeyId?: string;
    name?: string;
    /** A $0 probe (doctor --prove): needs a $0 budget and a ttl of at most 300 s. */
    probe?: true;
  },
) => apiCall<Minted>(io, 'POST', '/v1/sessions', body, auth);

/**
 * Revoke a session key, with the key itself unless `auth` names another (its parent key, or an
 * admin token); returns what the session spent.
 */
export const endSession = (
  io: Io,
  s: { keyId: string; token: string },
  auth: Record<string, string> = { 'x-brake-key': s.token },
) =>
  apiCall<{ spentMicros: number; heldMicros: number }>(
    io,
    'DELETE',
    `/v1/sessions/${s.keyId}`,
    undefined,
    auth,
  );

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
