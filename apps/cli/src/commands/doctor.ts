import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { type Me, type Minted, endSession, mintSession } from '../admin.js';
import {
  EXIT,
  type Io,
  config,
  keyHeaders,
  microsToUsd,
  savedConfigs,
  withTimeout,
} from '../io.js';
import { type ProxyRequest, proxyCall } from '../proxy.js';

type Status = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Check {
  id: string;
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

/** What a client cannot see, printed with every report: doctor never promises protection. */
export const NOT_VERIFIED = [
  "That the agent's HTTP clients go through the proxy: a route to a provider that bypasses Spend Brake is not capped.",
  'Credentials outside the environment, the saved brake config and ./.env* files (other files, keychains, browser profiles, cloud metadata).',
  "Network egress: only a firewall or egress policy that blocks the providers' own hosts makes the proxy the only way out.",
  'The org-wide cap and environment caps, which a virtual key cannot read.',
  "That catalog prices match the provider's invoice.",
  'Spend from other keys, users or machines in the same org.',
];

/** Environment variables that usually hold a provider's own key. */
const PROVIDER_KEY_VARS = [
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'BRAVE_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'SERPAPI_API_KEY',
  'SERPAPI_KEY',
  'GOOGLE_MAPS_KEY',
  'GOOGLE_MAPS_API_KEY',
  'MAPBOX_TOKEN',
  'MAPBOX_ACCESS_TOKEN',
  'HERE_API_KEY',
  'TWILIO_AUTH_TOKEN',
];

const ADMIN_TOKEN = /^sbt_[0-9A-Za-z]{32}$/;
const VIRTUAL_KEY = /^sb_live_[0-9A-Za-z]{22}$/;
/** Values that look like a provider key whatever the variable is called. */
const PROVIDER_KEY_SHAPES: [string, RegExp][] = [
  ['Tavily', /^tvly-[0-9A-Za-z-]{16,}$/],
  ['Mapbox secret', /^sk\.eyJ[0-9A-Za-z._-]+$/],
  // Public tokens are billable too (geocoding, search), and a URL restriction is only a header.
  ['Mapbox public', /^pk\.eyJ[0-9A-Za-z._-]+$/],
];
/**
 * A Google API key may be for Gemini, not Maps: only a warning, unless the variable names Maps.
 * One that may call Maps reaches it around the proxy.
 */
const GOOGLE_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
const GOOGLE_KEY_VARS = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];

type Found = { name: string; kind: 'admin' | 'provider' | 'google' | 'virtual'; what: string };

/** Example values (`.env.example`, docs): `your_tavily_api_key_here`, `tvly-xxxxxxxxxxxxxxxx`. */
const PLACEHOLDER =
  /your[_-]|[_-]here$|change[_-]?me|placeholder|example|dummy|redacted|^<.*>$|\.\.\.|(.)\1{7,}/i;

/** Classify one variable without keeping its value. `strict` is for files: no placeholders. */
function classify(name: string, value: string, key: string | undefined, strict: boolean) {
  const v = value.trim();
  if (!v || PLACEHOLDER.test(v)) return null;
  if (name === 'BRAKE_ADMIN_TOKEN' || ADMIN_TOKEN.test(v)) {
    return { name, kind: 'admin', what: 'admin token' } as Found;
  }
  if (VIRTUAL_KEY.test(v)) {
    return v === key ? null : ({ name, kind: 'virtual', what: 'virtual key' } as Found);
  }
  for (const [label, re] of PROVIDER_KEY_SHAPES) {
    if (re.test(v)) return { name, kind: 'provider', what: `${label} key` } as Found;
  }
  if (GOOGLE_KEY.test(v) && !PROVIDER_KEY_VARS.includes(name)) {
    return { name, kind: 'google', what: 'Google API key' } as Found;
  }
  if (GOOGLE_KEY_VARS.includes(name) && (!strict || /^[0-9A-Za-z._-]{16,}$/.test(v))) {
    return { name, kind: 'google', what: 'Google API key' } as Found;
  }
  if (PROVIDER_KEY_VARS.includes(name) && (!strict || /^[0-9A-Za-z._-]{16,}$/.test(v))) {
    return { name, kind: 'provider', what: 'provider key' } as Found;
  }
  return null;
}

/** A dotenv value: the inside of a quoted value, or an unquoted one without its `# comment`. */
export function dotenvValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  return v.replace(/(^|\s)#.*$/, '').trim();
}

/** Bigger files are not read, and are reported as not checked. */
const MAX_DOTENV_BYTES = 10_000_000;

/**
 * `.env*` files in the working directory, as name/value pairs, and the ones too big to read.
 * `listed` is false when the directory itself could not be read.
 */
function dotenvFiles(dir: string): {
  files: { file: string; vars: [string, string][] }[];
  skipped: string[];
  listed: boolean;
} {
  const files: { file: string; vars: [string, string][] }[] = [];
  const skipped: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^\.env/.test(f));
  } catch {
    return { files, skipped, listed: false };
  }
  for (const f of names.sort()) {
    const path = join(dir, f);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_DOTENV_BYTES) {
        skipped.push(path);
        continue;
      }
      const vars: [string, string][] = [];
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (m) vars.push([m[1]!, dotenvValue(m[2]!)]);
      }
      files.push({ file: path, vars });
    } catch {
      // unreadable: not reachable by this user either
    }
  }
  return { files, skipped, listed: true };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Checks that need nothing but this process: what the workload could read. */
export function localChecks(io: Io, cwd: string): Check[] {
  const checks: Check[] = [];
  const cfg = config(io);

  checks.push(
    cfg.key
      ? { id: 'key.present', status: 'pass', title: 'BRAKE_KEY is set' }
      : {
          id: 'key.present',
          status: 'fail',
          title: 'BRAKE_KEY is not set',
          detail: 'Without a virtual key nothing this workload calls goes through the proxy.',
          fix: 'Export BRAKE_KEY, or run the workload inside `brake session`.',
        },
  );

  const env = Object.entries(io.env)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => classify(k, v, cfg.key, false))
    .filter((f): f is Found => f !== null);
  const names = (kind: Found['kind']) =>
    env
      .filter((f) => f.kind === kind)
      .map((f) => `${f.name} (${f.what})`)
      .join(', ');

  checks.push(
    names('admin')
      ? {
          id: 'admin-token.env',
          status: 'fail',
          title: 'An admin token is in the environment',
          detail: `${names('admin')}. With it the workload can raise or remove its own caps.`,
          fix: 'Unset it for the workload; `brake session` drops BRAKE_ADMIN_TOKEN, other names it cannot know.',
        }
      : { id: 'admin-token.env', status: 'pass', title: 'No admin token in the environment' },
  );

  const configs = savedConfigs(io);
  const withToken = configs.found.filter((c) => c.cfg.adminToken).map((c) => c.path);
  checks.push(
    withToken.length
      ? {
          id: 'admin-token.config',
          status: 'fail',
          title: 'The saved admin token is readable',
          detail: `${withToken.join(', ')} holds an admin token this user can read, so the workload can lift its own caps.`,
          fix: 'Run the workload as another OS user than the one that ran `brake init`. Pointing XDG_CONFIG_HOME elsewhere only hides the file from brake, not from the agent.',
        }
      : configs.looked.length
        ? {
            id: 'admin-token.config',
            status: 'pass',
            title: 'No readable saved admin token',
            detail: `Looked at ${configs.looked.join(' and ')}; copies elsewhere are not checked.`,
          }
        : {
            // Nothing looked at is nothing checked: never a pass.
            id: 'admin-token.config',
            status: 'unknown',
            title: 'Could not look for a saved admin token',
            detail:
              'HOME and XDG_CONFIG_HOME are unset and the OS gave no home directory, so no config was read.',
            fix: 'Set HOME for the workload and run `brake doctor` again.',
          },
  );

  checks.push(
    names('provider')
      ? {
          id: 'provider-keys.env',
          status: 'fail',
          title: 'A provider key is in the environment',
          detail: `${names('provider')}. With it the workload can call the provider directly, around the proxy and its caps.`,
          fix: "Store the provider key in Spend Brake (it never needs to reach the agent) and unset it in the workload's environment.",
        }
      : {
          id: 'provider-keys.env',
          status: 'pass',
          title: 'No provider keys in the environment',
          detail: `Looked for ${PROVIDER_KEY_VARS.length} known variable names and key-shaped values.`,
        },
  );

  checks.push(
    names('google')
      ? {
          id: 'google-keys.env',
          status: 'warn',
          title: 'A Google API key is in the environment',
          detail: `${names('google')}. It may be for Gemini; if it can also call the Maps APIs, the workload can reach them around the proxy and its caps.`,
          fix: 'In Google Cloud, restrict the key to the APIs it is for (not Maps), or store the Maps key in Spend Brake only.',
        }
      : { id: 'google-keys.env', status: 'pass', title: 'No Google API keys in the environment' },
  );

  checks.push(
    names('virtual')
      ? {
          id: 'virtual-keys.env',
          status: 'warn',
          title: 'Another virtual key is in the environment',
          detail: `${names('virtual')}. Doctor checks the caps of BRAKE_KEY only; the workload may use this one instead.`,
          fix: 'Give the workload one virtual key.',
        }
      : {
          id: 'virtual-keys.env',
          status: 'pass',
          title: 'No other virtual keys in the environment',
        },
  );

  const scan = dotenvFiles(cwd);
  const files = scan.files.map(({ file, vars }) => ({
    file,
    found: vars
      .map(([k, v]) => classify(k, v, cfg.key, true))
      .filter((f): f is Found => f !== null),
  }));
  // Other virtual keys get their own check: doctor cannot vouch while one is readable.
  const virtual = files.flatMap((f) =>
    f.found.filter((x) => x.kind === 'virtual').map((x) => `${f.file}: ${x.name}`),
  );
  for (const f of files) f.found = f.found.filter((x) => x.kind !== 'virtual');
  checks.push(
    virtual.length
      ? {
          id: 'virtual-keys.files',
          status: 'warn',
          title: 'Another virtual key is in .env files the workload can read',
          detail: `${virtual.join(', ')}. Doctor checks the caps of BRAKE_KEY only; the workload may use this one instead.`,
          fix: 'Give the workload one virtual key.',
        }
      : !scan.listed || scan.skipped.length
        ? {
            // A file doctor did not read may hold one: no vouching for it.
            id: 'virtual-keys.files',
            status: 'unknown',
            title:
              'Could not check every .env file in the working directory for another virtual key',
            detail: !scan.listed
              ? `${cwd} could not be read.`
              : `Not read (over ${MAX_DOTENV_BYTES / 1_000_000} MB): ${scan.skipped.join(', ')}.`,
          }
        : {
            id: 'virtual-keys.files',
            status: 'pass',
            title: 'No other virtual keys in .env files in the working directory',
          },
  );
  const hits = files.filter((f) => f.found.length > 0);
  const severe = hits.some((f) => f.found.some((x) => x.kind === 'admin' || x.kind === 'provider'));
  const notRead = scan.skipped.length
    ? ` Not read (over ${MAX_DOTENV_BYTES / 1_000_000} MB): ${scan.skipped.join(', ')}.`
    : '';
  checks.push(
    hits.length
      ? {
          id: 'files.cwd',
          // A file doctor could not read may hold what the others do not: no vouching for it.
          status: severe ? 'fail' : scan.skipped.length ? 'unknown' : 'warn',
          title: 'Secrets in .env files the workload can read',
          detail:
            hits
              .map((h) => `${h.file}: ${h.found.map((x) => `${x.name} (${x.what})`).join(', ')}`)
              .join('; ') + notRead,
          fix: 'Move the secrets out of the workspace the agent works in.',
        }
      : !scan.listed
        ? {
            id: 'files.cwd',
            status: 'unknown',
            title: 'Could not list the working directory',
            detail: `${cwd} could not be read, so its .env files were not checked.`,
          }
        : scan.skipped.length
          ? {
              id: 'files.cwd',
              status: 'unknown',
              title: 'Some .env files in the working directory were not checked',
              detail: `Looked at ${plural(files.length, 'file')} in ${cwd}.${notRead}`,
            }
          : {
              id: 'files.cwd',
              status: 'pass',
              title: 'No secrets in .env files in the working directory',
              detail: `Looked at ${plural(files.length, 'file')} in ${cwd} (not subfolders).`,
            },
  );

  for (const [name, which, url] of [
    ['proxy', 'proxy', cfg.proxyUrl],
    ['admin API', 'api', cfg.apiUrl],
  ] as const) {
    let host = '';
    try {
      const u = new URL(url);
      host = u.protocol === 'http:' ? u.hostname : '';
    } catch {
      // reported by the reachability check
    }
    if (host && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
      checks.push({
        id: `transport.tls.${which}`,
        status: 'warn',
        title: `The ${name} URL is plain HTTP`,
        detail: `${url}: the virtual key travels unencrypted.`,
        fix: 'Use https://, or reach the service over a private network only.',
      });
    }
  }
  return checks;
}

/** Every request doctor makes, and its body, gets this long before it is reported as unanswered. */
const TIMEOUT_MS = 10_000;

/**
 * Readiness at the first of `paths` the server knows (a 404 tries the next). Only a JSON answer
 * with `ok: true` counts: a web server in front, such as the dashboard's, answers any path with
 * its own page.
 * `unchecked` is set when the service answered but has no readiness report doctor can reach, or
 * the API's rate limit kept it from answering one.
 */
async function ready(
  io: Io,
  base: string,
  paths: string[] = ['/readyz'],
): Promise<{ ok: boolean; detail: string; unchecked?: boolean }> {
  let detail = '';
  // The API's own JSON 404 on /v1/readyz: an API before 0.3.0, which only the dashboard's /v1
  // forwarding may reach, so its /readyz may be the dashboard's page.
  let older = '';
  for (const path of paths) {
    let res: Response;
    let body: string;
    try {
      res = await io.fetch(`${base}${path}`);
      body = await res.text();
    } catch (err) {
      return { ok: false, detail: `cannot reach ${base}: ${(err as Error).message}` };
    }
    detail = `${base}${path} answered HTTP ${res.status} ${body.slice(0, 200)}`;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    const isJson = typeof json === 'object' && json !== null;
    if (res.status === 404) {
      if (isJson && path === '/v1/readyz') older = `${base}${path}`;
      continue;
    }
    // The API's own rate limit on /v1/readyz: the API answered, but not with its readiness. Its
    // /readyz may be the dashboard's page, so it is not asked instead.
    if (res.status === 429 && isJson && path === '/v1/readyz') {
      return {
        ok: true,
        unchecked: true,
        detail: `${base}${path} answered HTTP 429: the API is reachable but rate limited, so its readiness was not checked.`,
      };
    }
    if (!isJson) {
      if (older) break;
      return {
        ok: false,
        detail:
          res.status >= 500
            ? `${base}${path} answered HTTP ${res.status} with a page: a web server in front of the service answered, and the service behind it may be down.`
            : `${base}${path} answered HTTP ${res.status} with a page, not a Spend Brake readiness report: is this URL a website in front of the service?`,
      };
    }
    return { ok: res.ok && (json as { ok?: unknown }).ok === true, detail };
  }
  if (older) {
    return {
      ok: true,
      unchecked: true,
      detail: `${older} answered with the API's own 404: it is reachable, but older than 0.3.0, so its readiness was not checked.`,
    };
  }
  return { ok: false, detail };
}

/**
 * Proxy refusals sent before the caps are checked: the probe proves nothing either way. An
 * internal error may come before or after forwarding; the session's spend, read back when it is
 * ended, tells. Any other answer (the provider's own, upstream_timeout, upstream_unavailable)
 * means the $0 cap let the request through.
 */
const REFUSED_BEFORE_CAPS = [
  'invalid_key',
  'invalid_request',
  'loop_detected',
  'budget_unavailable',
  'internal_error',
];

/** A cheap priced request per provider, refused by a $0 cap before the provider is called. */
const PROBES: Record<string, ProxyRequest> = {
  tavily: {
    method: 'POST',
    path: '/tavily/search',
    body: { query: 'spend brake doctor probe', search_depth: 'basic', max_results: 1 },
  },
  exa: {
    method: 'POST',
    path: '/exa/search',
    body: { query: 'spend brake doctor probe', type: 'lite', numResults: 1 },
  },
  brave: { method: 'GET', path: '/brave/res/v1/web/search', query: { q: 'spend brake' } },
  serpapi: {
    method: 'GET',
    path: '/serpapi/search.json',
    query: { engine: 'google', q: 'spend brake' },
  },
  'google-maps': {
    method: 'GET',
    path: '/google-maps/maps/api/geocode/json',
    query: { address: 'Sofia' },
  },
};

/**
 * Mint a $0 session from the key and send one priced request with it: the proxy must refuse it
 * with budget_exceeded, before it loads the credential or contacts the provider.
 */
async function prove(io: Io, me: Me | null): Promise<Check> {
  const id = 'enforcement.exhausted-budget';
  const title = 'An exhausted budget stops forwarding';
  const cfg = config(io);
  if (!me) return { id, status: 'unknown', title, detail: 'The key could not be checked.' };
  if (me.sessionId) {
    return {
      id,
      status: 'unknown',
      title,
      detail: 'This is a session key, and session keys cannot mint the $0 probe session.',
      fix: 'Run `brake doctor --prove` with the parent key.',
    };
  }
  // Before 0.3.0 the server has no probe sessions: a $0 session would count against the plan.
  if (!me.policy) {
    return {
      id,
      status: 'unknown',
      title,
      detail: 'The server is older than 0.3.0, too old for --prove: it has no $0 probe sessions.',
      fix: 'Upgrade the Spend Brake server to 0.3.0 or later.',
    };
  }
  if (!me.policy.canMintSessions) {
    return {
      id,
      status: 'unknown',
      title,
      detail: 'The key may not mint sessions, so doctor cannot make a $0 budget to test.',
      fix: 'Run `brake doctor --prove` with a key created with --can-mint-sessions.',
    };
  }
  let killed = me.killed;
  // Killed may mean the BRAKE_SESSION this client names, which the probe does not use: ask again
  // without it.
  if (killed && cfg.session) {
    try {
      const res = await io.fetch(`${cfg.apiUrl}/v1/me`, { headers: { 'x-brake-key': cfg.key! } });
      if (res.ok) killed = ((await res.json()) as Me).killed;
    } catch {
      // keep what /v1/me said
    }
  }
  if (killed) {
    return {
      id,
      status: 'unknown',
      title,
      detail:
        'Spending is switched off for this key, so the proxy refuses the probe whatever its caps.',
    };
  }
  const allowed = me.policy.providers.filter((p) => Object.hasOwn(PROBES, p));
  if (allowed.length === 0) {
    return {
      id,
      status: 'unknown',
      title,
      detail: `Doctor has a probe for ${Object.keys(PROBES).join(', ')}; this key calls none of them.`,
    };
  }
  // A killed provider is refused before its caps are checked: it proves nothing.
  const providers = allowed.filter((p) => !me.killedProviders?.includes(p));
  if (providers.length === 0) {
    return {
      id,
      status: 'unknown',
      title,
      detail: `Every provider doctor could probe with this key is switched off: ${allowed.join(', ')}.`,
    };
  }

  let minted: Minted;
  try {
    minted = await mintSession(
      io,
      { 'x-brake-key': cfg.key! },
      {
        budgetMicros: '0',
        dayBudgetMicros: '0',
        // No agentId: the session is the key's own agent's (the API refuses another one). The
        // probe key's $0 cap refuses the call before any agent cap could be created.
        ttlSec: 60,
        name: 'brake doctor probe',
        // Asked for: the API never takes a $0 session for a probe from its shape alone.
        probe: true,
      },
    );
  } catch (err) {
    return {
      id,
      status: 'unknown',
      title,
      detail: `Could not mint the $0 probe session: ${(err as Error).message}`,
    };
  }

  const probeIo: Io = {
    ...io,
    env: { ...io.env, BRAKE_KEY: minted.token, BRAKE_SESSION: undefined },
  };
  let result: Check | null = null;
  try {
    for (const p of providers) {
      let r;
      try {
        r = await proxyCall(probeIo, PROBES[p]!);
      } catch (err) {
        result = {
          id,
          status: 'unknown',
          title,
          detail: `The ${p} probe did not get an answer: ${(err as Error).message}`,
        };
        break;
      }
      const e = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as {
        error?: unknown;
      };
      // A provider's own error body may hold anything under `error`.
      const code = typeof e.error === 'string' ? e.error : '';
      const charged = r.costMicros !== null && r.costMicros > 0;
      // Not this key's provider, not one this proxy serves or prices, or switched off since
      // /v1/me: refused before the caps, so try the next.
      if (
        !charged &&
        ((r.status === 403 && code === 'sku_not_allowed') ||
          (r.status === 404 && code === 'unknown_route') ||
          code === 'killed' ||
          code === 'unpriced_route')
      ) {
        continue;
      }
      if (charged) {
        result = {
          id,
          status: 'fail',
          title,
          detail: `The proxy charged ${r.cost} for a priced ${p} request on a $0 session (HTTP ${r.status}).`,
          fix: 'Report this: caps are not being enforced on this install.',
        };
      } else if (r.status === 402 && code === 'budget_exceeded') {
        result = {
          id,
          status: 'pass',
          title,
          detail: `A priced ${p} request on a $0 session was refused before forwarding (402 budget_exceeded, cost $0, request ${r.requestId ?? 'unknown'}).`,
        };
      } else if (r.ok) {
        result = {
          id,
          status: 'fail',
          title,
          detail: `The proxy FORWARDED a priced ${p} request on a $0 session (HTTP ${r.status}, cost ${r.cost ?? 'unknown'}).`,
          fix: 'Report this: caps are not being enforced on this install.',
        };
      } else if (REFUSED_BEFORE_CAPS.includes(code)) {
        result = {
          id,
          status: 'unknown',
          title,
          detail: `The ${p} probe was refused with HTTP ${r.status} ${code} before its caps were checked.`,
        };
      } else {
        // The provider answered (an error of its own), or the proxy forwarded and the provider
        // did not answer: either way the $0 cap did not stop it.
        result = {
          id,
          status: 'fail',
          title,
          detail: `The proxy FORWARDED a priced ${p} request on a $0 session: it answered HTTP ${r.status}${code ? ` ${code}` : ''}, not a budget refusal (cost ${r.cost ?? 'unknown'}).`,
          fix: 'Report this: caps are not being enforced on this install.',
        };
      }
      break;
    }
  } finally {
    let end: { spentMicros?: number; heldMicros?: number } = {};
    let endError = '';
    try {
      // With the parent key: the probe's own token stops working when its 60 s are up.
      end = await endSession(io, minted, { 'x-brake-key': cfg.key! });
    } catch (err) {
      // the session expires in 60 s anyway, but its spend is then unread
      endError = (err as Error).message;
    }
    const unread =
      endError ||
      (typeof end.spentMicros !== 'number' || typeof end.heldMicros !== 'number'
        ? 'the API did not say what it spent or holds'
        : '');
    // A hold is a charge reserved for a forwarded call: on a $0 session there must be none.
    if (end.spentMicros || end.heldMicros) {
      result = {
        id,
        status: 'fail',
        title,
        detail: end.spentMicros
          ? `The $0 probe session spent ${microsToUsd(end.spentMicros)}.`
          : `The $0 probe session holds ${microsToUsd(end.heldMicros!)} for a call in flight.`,
        fix: 'Report this: caps are not being enforced on this install.',
      };
    } else if (unread && result?.status === 'pass') {
      // The refusal alone does not prove the probe charged nothing.
      result = {
        id,
        status: 'unknown',
        title,
        detail: `${result.detail} But the probe session's spend could not be read back when ending it: ${unread}.`,
      };
    }
  }
  return (
    result ?? {
      id,
      status: 'unknown',
      title,
      detail: `No probe reached the caps: ${providers.join(', ')} refused it for another reason first (not allowed, unpriced or switched off).`,
    }
  );
}

/** Checks against the running proxy and API, from the key's point of view. */
export async function remoteChecks(
  io: Io,
  opts: { prove: boolean },
): Promise<{ checks: Check[]; me: Me | null }> {
  const cfg = config(io);
  const checks: Check[] = [];
  // The API also answers under /v1, the only path the dashboard domain forwards to it.
  const [proxy, api] = await Promise.all([
    ready(io, cfg.proxyUrl),
    ready(io, cfg.apiUrl, ['/v1/readyz', '/readyz']),
  ]);
  checks.push(
    {
      id: 'proxy.reachable',
      status: proxy.ok ? 'pass' : 'fail',
      title: 'The proxy is ready',
      detail: proxy.detail,
    },
    {
      id: 'api.reachable',
      status: !api.ok ? 'fail' : api.unchecked ? 'warn' : 'pass',
      title: api.unchecked
        ? 'The admin API answers; its readiness was not checked'
        : 'The admin API is ready',
      detail: api.detail,
    },
  );
  if (!cfg.key) return { checks, me: null };
  // Whatever stopped doctor from reading the key, the checks it then skipped are reported as
  // not checked, never left out: a report without them would read as passing.
  const unchecked = async (): Promise<{ checks: Check[]; me: null }> => {
    checks.push({
      id: 'key.capped',
      status: 'unknown',
      title: 'Could not check the caps on this key',
    });
    if (opts.prove) checks.push(await prove(io, null));
    return { checks, me: null };
  };
  if (!api.ok) {
    checks.push({
      id: 'key.valid',
      status: 'unknown',
      title: 'Could not check BRAKE_KEY',
      detail: 'The admin API is not ready, so the key, its caps and its policy were not checked.',
    });
    return unchecked();
  }

  let me: Me | null = null;
  try {
    const res = await io.fetch(`${cfg.apiUrl}/v1/me`, { headers: keyHeaders(cfg) });
    if (res.ok) me = (await res.json()) as Me;
    else if (res.status === 401 || res.status === 403)
      checks.push({
        id: 'key.valid',
        status: 'fail',
        title: 'BRAKE_KEY is not a working key',
        detail: `GET /v1/me answered HTTP ${res.status}: the key is unknown, revoked, expired or not allowed from this IP.`,
      });
    else if (res.status === 400 && cfg.session) {
      const e = (await res.json().catch(() => ({}))) as { message?: string };
      checks.push({
        id: 'key.session',
        status: 'fail',
        title: 'The proxy refuses every call with this BRAKE_SESSION',
        detail: e.message ?? `GET /v1/me answered HTTP ${res.status}.`,
        fix: 'Unset BRAKE_SESSION, or use a key with a session budget and a name of up to 128 letters, digits, `.`, `_` or `-`.',
      });
    } else
      checks.push({
        id: 'key.valid',
        status: 'unknown',
        title: 'Could not check BRAKE_KEY',
        detail: `GET /v1/me answered HTTP ${res.status}; the key, its caps and its policy were not checked.`,
      });
  } catch (err) {
    checks.push({
      id: 'key.valid',
      status: 'unknown',
      title: 'Could not check BRAKE_KEY',
      detail: (err as Error).message,
    });
  }
  if (!me) return unchecked();

  checks.push({
    id: 'key.valid',
    status: 'pass',
    title: 'BRAKE_KEY works',
    detail: `Key ${me.keyId}${me.sessionId ? `, session ${me.sessionId}` : ''}.`,
  });
  // Killed because every one of its providers is: name them, the key itself is not killed.
  const allProviders =
    me.killedProviders?.length && me.policy
      ? me.policy.providers.every((p) => me.killedProviders!.includes(p))
      : false;
  checks.push(
    me.killed && allProviders
      ? {
          id: 'key.killed',
          status: 'fail',
          title: "Every one of this key's providers is switched off",
          // /v1/me says killed, not by what: the key, its parent or the org may be killed too.
          detail: `${me.killedProviders!.join(', ')}: every call is refused. The key, its parent or the org may be killed as well; doctor cannot tell.`,
          fix: `Expected after a kill; resume them with ${me.killedProviders!.map((p) => `\`brake unkill prov:${p}\``).join(', ')} when ready, and with \`brake unkill key:${me.keyId}\`, the parent key or \`brake unkill org\` if those are killed too.`,
        }
      : me.killed
        ? {
            id: 'key.killed',
            status: 'fail',
            title: 'Spending is switched off for this key',
            detail: 'The key, its parent, its session or the org is killed: every call is refused.',
            fix: 'Expected after a kill; resume it with `brake unkill` when ready.',
          }
        : me.killedProviders?.length
          ? {
              id: 'key.killed',
              status: 'warn',
              title: "Some of this key's providers are switched off",
              detail: `${me.killedProviders.join(', ')}: every call to them is refused.`,
              fix: 'Expected after a kill; resume them with `brake unkill` when ready.',
            }
          : { id: 'key.killed', status: 'pass', title: 'Spending is switched on' },
  );
  // A session the client names (X-Brake-Session) is no limit: the client can pick a fresh name,
  // or send none. Only a session key's own session binds it.
  const named = (s: Me['scopes'][number]) => !me.sessionId && s.scope.startsWith('sess:');
  // A key that mints sessions is bounded by its own cap only: each session it mints brings its
  // own budget, and the first one sets the agent's day cap when none is set.
  const minter = !me.sessionId && me.policy?.canMintSessions === true;
  const binds = (s: Me['scopes'][number]) =>
    !named(s) && (!minter || s.scope === `key:${me.keyId}`);
  const capped = me.scopes.filter((s) => s.hard !== null && binds(s));
  const namedOnly = !capped.length && me.scopes.some((s) => s.hard !== null && named(s));
  const otherOnly = !capped.length && minter && me.scopes.some((s) => s.hard !== null && !named(s));
  checks.push(
    capped.length
      ? {
          id: 'key.capped',
          status: 'pass',
          title: 'A hard cap applies to this key',
          detail: capped
            .map(
              (s) =>
                `${s.scope} ${s.window}: cap ${microsToUsd(s.hard!, 2)}, remaining ${microsToUsd(s.remaining ?? 0, 2)}`,
            )
            .join('; '),
        }
      : otherOnly
        ? {
            id: 'key.capped',
            status: 'fail',
            title: 'This key may mint sessions, and no cap is set on the key itself',
            detail:
              'Each session it mints chooses its own budget, and the first one sets the agent day cap when none is set: only a cap on this key bounds them all.',
            fix: `Cap the key itself: \`brake caps set key:${me.keyId} --day 5 --month 50\`.`,
          }
        : namedOnly
          ? {
              id: 'key.capped',
              status: 'fail',
              title: 'Only a per-session budget caps this key, and the client names the session',
              detail:
                'A client can send a new X-Brake-Session for a fresh budget each time, or none, so nothing bounds its total. An org cap may exist, but a key cannot read it.',
              fix: 'Cap the key itself: `brake caps set key:<id> --day 5 --month 50`, or give the workload session keys (`brake session`).',
            }
          : {
              id: 'key.capped',
              status: 'fail',
              title: 'No cap that doctor can see applies to this key',
              detail:
                'The key, its session, its parent and its agent have no hard cap. An org cap may exist, but a key cannot read it.',
              fix: 'Set a cap: `brake caps set key:<id> --day 5`, or run the workload in `brake session`.',
            },
  );

  const p = me.policy;
  if (!p) {
    checks.push({
      id: 'key.policy',
      status: 'unknown',
      title: "The server does not report the key's policy",
      detail: 'Providers, unpriced-route policy, expiry and fail-open could not be checked.',
      fix: 'Upgrade the Spend Brake server to 0.3.0 or later.',
    });
  } else {
    if (!me.sessionId && p.expiresAt === null) {
      checks.push({
        id: 'key.expiry',
        status: 'warn',
        title: 'The key never expires',
        detail: 'A leaked key keeps working until someone revokes it.',
        fix: 'Give agents session keys (`brake session`) or keys with an expiry.',
      });
    }
    if (p.failOpenMicros) {
      checks.push({
        id: 'key.fail-open',
        status: 'warn',
        title: 'The key fails open',
        detail: `While the budget store is down, the proxy forwards up to ${microsToUsd(p.failOpenMicros, 2)} a day for it without checking caps.`,
        fix: 'Set failOpenMicros to null for agent keys.',
      });
    }
    checks.push({
      id: 'providers.scope',
      status: p.providers.length > 5 ? 'warn' : 'pass',
      title: `The key may call ${plural(p.providers.length, 'provider')}`,
      detail: p.providers.join(', ') || 'none',
      ...(p.providers.length > 5
        ? { fix: 'Give the workload a key with only the providers it needs.' }
        : {}),
    });
    if (p.skus) {
      checks.push({
        id: 'providers.skus',
        status: 'pass',
        title: 'The key is limited to some SKUs',
        detail: p.skus.join(', '),
      });
    }
    // The proxy forwards an unpriced route only with a default price; without one it refuses.
    const open = Object.entries(p.unpriced).filter(
      ([, u]) => u.policy !== 'deny' && u.defaultPriceMicros !== null,
    );
    const free = open.filter(([, u]) => u.defaultPriceMicros === 0);
    const priced = open.filter(([, u]) => u.defaultPriceMicros !== 0);
    if (free.length) {
      checks.push({
        id: 'providers.unpriced-free',
        status: 'fail',
        title: 'Unpriced routes cost nothing against the caps',
        detail: `${free.map(([prov]) => prov).join(', ')}: unpriced calls are charged $0, so until a cap is already used up they are forwarded without limit.`,
        fix: 'Set unpricedPolicy to deny, or a defaultPriceMicros above what the provider charges (PUT /v1/org).',
      });
    }
    if (priced.length) {
      checks.push({
        id: 'providers.unpriced',
        status: 'warn',
        title: 'Unpriced routes are forwarded for some providers',
        detail: priced
          .map(
            ([prov, u]) =>
              `${prov}: charged ${microsToUsd(u.defaultPriceMicros!)} a call, which may be less than the provider bills`,
          )
          .join('; '),
        fix: 'Set unpricedPolicy to deny for these providers (PUT /v1/org).',
      });
    }
    if (!open.length) {
      checks.push({
        id: 'providers.unpriced',
        status: 'pass',
        title: 'Routes with no known price are refused',
      });
    }
  }

  if (opts.prove) {
    checks.push(
      proxy.ok
        ? await prove(io, me)
        : {
            id: 'enforcement.exhausted-budget',
            status: 'unknown',
            title: 'An exhausted budget stops forwarding',
            detail:
              'Skipped: the proxy is not ready, and a fail-open key may forward while it is degraded.',
          },
    );
  }
  return { checks, me };
}

const LABEL: Record<Status, string> = { pass: 'ok  ', warn: 'WARN', fail: 'FAIL', unknown: '??  ' };

export function doctorCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('doctor')
    .description(
      'Check what can let this workload spend past its caps; run it where the agent runs',
    )
    .option(
      '--prove',
      'mint a $0 session and show the proxy refuses a priced call (spends nothing)',
    )
    .option('--pretty', 'human-readable output instead of JSON')
    .action(async (o: { prove?: boolean }, cmd: Command) => {
      const pretty = Boolean(cmd.optsWithGlobals<{ pretty?: boolean }>().pretty);
      const local = localChecks(io, io.cwd?.() ?? process.cwd());
      const { checks: remote } = await remoteChecks(withTimeout(io, TIMEOUT_MS), {
        prove: Boolean(o.prove),
      });
      const checks = [...local, ...remote];
      const summary = { pass: 0, warn: 0, fail: 0, unknown: 0 };
      for (const c of checks) summary[c.status]++;
      // Doctor vouches only for what it saw: the caps on the key, and the probe when asked for.
      const passed = (id: string) => checks.some((c) => c.id === id && c.status === 'pass');
      // Another readable virtual key has caps doctor did not check.
      const otherKey = checks.some((c) => c.id.startsWith('virtual-keys.') && c.status === 'warn');
      // A .env file too big to read, a saved config doctor could not look for, or a server that
      // does not report the key's policy: what doctor did not see may be what lets the workload
      // spend.
      const unread = checks.some(
        (c) =>
          ['files.cwd', 'virtual-keys.files', 'admin-token.config', 'key.policy'].includes(c.id) &&
          c.status === 'unknown',
      );
      const ok =
        summary.fail === 0 &&
        !otherKey &&
        !unread &&
        passed('key.capped') &&
        (!o.prove || passed('enforcement.exhausted-budget'));
      if (!pretty) {
        io.stdout(`${JSON.stringify({ ok, summary, checks, notVerified: NOT_VERIFIED })}\n`);
      } else {
        const lines = [
          `brake doctor: ${summary.fail} failed, ${plural(summary.warn, 'warning')}, ${summary.pass} passed, ${summary.unknown} could not be checked`,
          '',
        ];
        for (const c of checks) {
          lines.push(`${LABEL[c.status]}  ${c.title}`);
          if (c.detail && c.status !== 'pass') lines.push(`      ${c.detail}`);
          if (c.fix && c.status !== 'pass') lines.push(`      fix: ${c.fix}`);
        }
        lines.push('', 'Not verified (doctor cannot see these):');
        for (const n of NOT_VERIFIED) lines.push(`  - ${n}`);
        lines.push(
          '',
          ok
            ? 'No failed checks in what doctor can verify. This is not a guarantee that every spend is capped.'
            : summary.fail
              ? 'Fix the failed checks above; until then doctor cannot vouch for this workload.'
              : otherKey
                ? 'Doctor checked the caps of BRAKE_KEY only, and the workload can read another virtual key, so it cannot vouch for this workload.'
                : 'Doctor could not check all of the above (caps, policy, .env files, the saved config or the --prove probe), so it cannot vouch for this workload.',
        );
        io.stdout(`${lines.join('\n')}\n`);
      }
      done(ok ? EXIT.ok : EXIT.error);
    });
}
