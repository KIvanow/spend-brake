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

/**
 * Another tab signed in or out: an email sign-in's token is shared through localStorage, so a
 * `storage` event for it changes who this tab is. Returns the token this tab now sends (null when
 * signed out), or undefined when the change does not affect this tab: one with its own pasted
 * or single sign-on token in sessionStorage keeps it.
 */
export function tokenChangedElsewhere(e: StorageEvent): { token: string | null } | undefined {
  if (e.key !== null && e.key !== TOKEN_KEY) return undefined;
  if (e.key !== null && e.oldValue === e.newValue) return undefined;
  try {
    if (store('session')?.getItem(TOKEN_KEY)) return undefined;
  } catch {
    // storage blocked: fall through and read what there is
  }
  return { token: getToken() };
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
  /** The proxy's outbound IPs: provider keys should be restricted to them. */
  egressIps: string[];
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
  const data = (await res.json().catch(() => ({}))) as ErrorBody;
  check(res, data, token);
  return data as T;
}

interface ErrorBody {
  message?: string;
  issues?: { message?: string }[];
}

function check(res: Response, data: ErrorBody, token: string | null): void {
  // Expired or revoked (sessions end when a role changes): back to the sign-in page. A request
  // that was in flight when the person signed out (or in again) changes nothing. A 401 on a
  // request sent with no token means another tab signed out and took the shared token with it.
  if (res.status === 401 && getToken() === token) {
    setToken(null);
    window.dispatchEvent(new Event(SIGNED_OUT));
  }
  if (!res.ok) {
    // A validation error's top-level message is generic; the first issue says what is wrong.
    throw new ApiError(
      res.status,
      data.issues?.[0]?.message ?? data.message ?? `HTTP ${res.status}`,
    );
  }
}

/**
 * Download an API file (a CSV export) under the name the API gives it. The token goes in a
 * header, so a plain link cannot do it: fetch (connect-src 'self'), then save the body through
 * a `blob:` URL and `<a download>`. A download is a navigation, which no CSP directive in
 * nginx.conf governs (img-src and frame-src are for embedding), so the CSP needs no change.
 * Returns the response headers (for X-Brake-Truncated) and the file saved.
 */
export async function download(
  path: string,
  fallbackName: string,
): Promise<{ headers: Headers; blob: Blob }> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) check(res, (await res.json().catch(() => ({}))) as ErrorBody, token);
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { headers: res.headers, blob };
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
  config: {
    env?: string | null;
    agentId?: string | null;
    sessionId?: string | null;
    /** provider -> provider credential id */
    credentials?: Record<string, string>;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (iso: string): Date | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * One date format across the dashboard: YYYY-MM-DD, in the browser's time zone. Budget windows
 * (Overview, Caps) are the exception: they are cut in the org's time zone and say so.
 */
export function localDate(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD HH:MM:SS in the browser's time zone. */
export function localDateTime(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return `${localDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The browser's time zone, e.g. "Europe/Sofia", for labels. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
