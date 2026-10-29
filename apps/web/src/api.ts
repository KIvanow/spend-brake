// Admin API client. The token lives in sessionStorage (cleared when the tab closes); the API is
// on the same origin (nginx in Docker, the Vite proxy in dev).

const TOKEN_KEY = 'brake.adminToken';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the token only lives in memory for this page
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const usd = (micros: number | null | undefined, decimals = 2): string => {
  if (micros === null || micros === undefined) return '—';
  const v = micros / 1_000_000;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

/** Dollars typed by a person to integer micros, exactly. */
export function toMicros(dollars: string): number | null {
  const m = /^\s*\$?(\d+)(?:\.(\d{1,6}))?\s*$/.exec(dollars);
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
}

export interface ScopeStatus {
  scope: string;
  window: string;
  spent: number;
  held: number;
  hard: number | null;
  soft: number | null;
  remaining: number | null;
}

export interface Cap {
  scope: string;
  kind: 'd' | 'm';
  hard: number | null;
  soft: number | null;
  version: number;
}

export interface Key {
  id: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked';
  createdAt: string;
  expiresAt: string | null;
  config: { env?: string | null; agentId?: string | null; sessionId?: string | null };
}
