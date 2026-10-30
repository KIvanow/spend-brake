// Admin API client. The API is on the same origin (nginx in Docker, the Vite proxy in dev).
//
// Where the token lives: a pasted or single sign-on token in sessionStorage (cleared when the
// tab closes); an email sign-in's token, which expires on its own after 7 days, in localStorage
// so people stay signed in across tabs.

const TOKEN_KEY = 'brake.adminToken';

function store(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  try {
    return store('session')?.getItem(TOKEN_KEY) ?? store('local')?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null, opts: { remember?: boolean } = {}): void {
  try {
    store('session')?.removeItem(TOKEN_KEY);
    store('local')?.removeItem(TOKEN_KEY);
    if (token) store(opts.remember ? 'local' : 'session')?.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked: the token only lives in memory for this page
  }
}

/** Drop a one-time value from the address bar and history, keeping the page's route. */
function clearHash(location: Location, route = '#/'): void {
  window.history.replaceState(null, '', `${location.pathname}${location.search}${route}`);
}

/**
 * Single sign-on ends with the token in the URL fragment (`#sso_token=...`), which never reaches
 * a server. Keep it like a pasted token and drop it from the address bar and history.
 */
export function takeSsoToken(location: Location = window.location): boolean {
  const m = /^#sso_token=(sbt_[0-9A-Za-z]{32})$/.exec(location.hash);
  if (!m) return false;
  setToken(m[1]!);
  clearHash(location);
  return true;
}

/** An emailed sign-in link opens `#login=<code>`: take the code (it is spent by the API). */
export function takeLoginCode(location: Location = window.location): string | null {
  const m = /^#login=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!m) return null;
  clearHash(location);
  return m[1]!;
}

/** Fired when the API stops accepting the stored token. */
export const SIGNED_OUT = 'brake:signed-out';

export interface AuthOptions {
  emailSignIn: boolean;
  signup: boolean;
  proxyUrl: string | null;
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
  if (res.status === 401 && token) {
    // Expired or revoked (sessions end when a role changes): back to the sign-in page.
    setToken(null);
    window.dispatchEvent(new Event(SIGNED_OUT));
  }
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
