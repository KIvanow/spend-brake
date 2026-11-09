import { apiExchange } from '../../admin.js';
import { CliError, EXIT, type Io, config, timedOut, usdToMicros, withTimeout } from '../../io.js';
import { type Json, type Tool, type ToolResult, jsonArg, result, text } from './protocol.js';

export const ADMIN_INSTRUCTIONS =
  'These tools administer one Spend Brake org with the admin token. A result that contains pending ' +
  'or pendingApproval is waiting for a second person and is not applied: do not send it again. A new ' +
  'key, session, token or webhook shows a secret once; give it to the user. A 403 license_required ' +
  'means this install does not have that Business or Enterprise feature. Approving a cap raise needs ' +
  'a person signed in through SSO; a bearer token is refused.';

const READ_MS = 10_000;
const SLOW_MS = 30_000;

const NO_ADMIN =
  'BRAKE_ADMIN_TOKEN is not set for this MCP server: add an admin token to the "env" of its entry in the MCP configuration.';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTROY = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Destructive, and reaches a host outside Spend Brake (stored secrets can go there). */
const EXPOSE = { ...DESTROY, openWorldHint: true };
/** A write that sends something to a host outside Spend Brake. */
const OUTBOUND = { ...WRITE, openWorldHint: true };

const str = { type: 'string' };
const strings = { type: 'array', items: { type: 'string' } };
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
const jsonObj = { type: 'object', additionalProperties: true };
const none: Json = { type: 'object', properties: {}, additionalProperties: false };
const usd = { ...str, description: 'Dollars, e.g. "5" or "0.25"' };

const ROLES = ['viewer', 'admin', 'owner'] as const;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;

function schema(properties: Json, required?: string[]): Json {
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

/** Scheme, host and port of a URL (what a secret is sent to); the input itself when unparsable. */
function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).origin;
  } catch {
    return String(url);
  }
}

function pathId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new CliError(`${name} must be a single token`, EXIT.usage);
  }
  return encodeURIComponent(value);
}

/** Fields `custom_apis_show` adds. The write routes reject them. */
const SHOWN_ONLY = ['proxyPath', 'createdAt', 'updatedAt'] as const;

/**
 * A custom API write body. Update drops `id` (it lives in the path) and refuses a different one.
 * Add keeps `id`.
 */
function customApiBody(value: unknown, id?: unknown): Json {
  const src = value as Json;
  if (id !== undefined && src.id !== undefined && src.id !== id) {
    throw new CliError(
      `definition is for ${JSON.stringify(src.id)}, not ${JSON.stringify(id)}`,
      EXIT.usage,
    );
  }
  const body: Json = { ...src };
  for (const k of SHOWN_ONLY) delete body[k];
  if (id !== undefined) delete body.id;
  return body;
}

/** A scope label (`org`, `key:<id>`, …). Not a path id: it may contain `:`. */
function scopeOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError('scope must be a non-empty string', EXIT.usage);
  }
  return encodeURIComponent(value);
}

function query(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') u.append(k, String(v));
    else if (Array.isArray(v))
      for (const item of v) if (typeof item === 'string') u.append(k, item);
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

interface CapRow {
  scope: string;
  kind: 'd' | 'm';
  hard: number | null;
  soft: number | null;
}

/**
 * The body of PUT /v1/caps. The API replaces a window's hard and soft values together (a value
 * left out is removed), so a window given only one of them keeps the other from the current cap.
 */
async function capsBody(io: Io, scope: string, a: Json) {
  const given = {
    day: [a.day, a.softDay],
    month: [a.month, a.softMonth],
  } as const;
  const asMicros = (v: unknown) => (typeof v === 'string' ? usdToMicros(v).toString() : undefined);
  const partial = Object.values(given).some(
    ([hard, soft]) => (typeof hard === 'string') !== (typeof soft === 'string'),
  );
  let current: CapRow[] = [];
  if (partial) {
    let data: { items: CapRow[] };
    try {
      ({ data } = await apiExchange<{ items: CapRow[] }>(
        withTimeout(io, READ_MS),
        'GET',
        '/v1/caps',
      ));
    } catch (err) {
      // Only a read so far: nothing was changed, so this may be retried.
      throw new CliError(
        timedOut(err)
          ? 'The admin API did not answer in time while reading the current caps. Nothing was changed.'
          : (err as Error).message,
        EXIT.error,
        { cause: err },
      );
    }
    current = data.items.filter((c) => c.scope === scope);
  }
  const body: Json = {};
  for (const [window, [hard, soft]] of Object.entries(given)) {
    if (typeof hard !== 'string' && typeof soft !== 'string') continue;
    const now = current.find((c) => c.kind === window[0]);
    const keep = (v: number | null | undefined) =>
      v === null || v === undefined ? null : String(v);
    body[window] = {
      hard: asMicros(hard) ?? keep(now?.hard),
      soft: asMicros(soft) ?? keep(now?.soft),
    };
  }
  return body;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function plain(data: unknown): Json {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as Json;
  return { result: data };
}

const METRICS_CAP = 100_000;
const AUDIT_CAP = 200;

type Present = (data: unknown, headers: Headers, raw: string) => Json;

function metricsText(_data: unknown, _headers: Headers, raw: string): Json {
  if (raw.length <= METRICS_CAP) return { text: raw };
  // At a line end: a half metric line would read as a different value.
  const cut = raw.lastIndexOf('\n', METRICS_CAP);
  return {
    text: raw.slice(0, cut > 0 ? cut + 1 : METRICS_CAP),
    truncated: true,
    note: 'Cut at about 100,000 characters, at a line end.',
  };
}

function auditLines(_data: unknown, headers: Headers, raw: string): Json {
  // Body text, not the parsed JSON: one JSON line still parses, and that would drop the cursor.
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const truncated = lines.length > AUDIT_CAP;
  const cursor = headers.get('x-next-cursor');
  const kept = truncated ? lines.slice(0, AUDIT_CAP) : lines;
  // The cursor is an audit row id. After a cut, the next page starts after the last line kept
  // (the API's own cursor is for its full page, and would skip the lines left out).
  let next: string | null = cursor;
  if (truncated) {
    try {
      const id = (JSON.parse(kept.at(-1)!) as { id?: unknown }).id;
      next = typeof id === 'string' || typeof id === 'number' ? String(id) : null;
    } catch {
      next = null;
    }
  }
  return {
    lines: kept,
    truncated,
    ...(next ? { nextCursor: next } : {}),
    ...(truncated
      ? { note: 'Cut at 200 lines. Pass nextCursor as cursor for the lines after these.' }
      : {}),
  };
}

async function admin(
  io: Io,
  structured: boolean,
  method: string,
  path: string,
  body?: unknown,
  timeout = READ_MS,
  present: Present = plain,
): Promise<ToolResult> {
  if (!config(io).adminToken) return text(NO_ADMIN, true);
  try {
    const {
      data,
      headers,
      text: raw,
    } = await apiExchange(withTimeout(io, timeout), method, path, body);
    return result(present(data, headers, raw), structured);
  } catch (err) {
    if (timedOut(err)) {
      // A GET changed nothing. A write may have landed before the answer came back.
      return text(
        method === 'GET'
          ? 'The admin API did not answer in time. Nothing was changed.'
          : 'The admin API did not answer in time. A change might have been applied: check before sending it again.',
        true,
      );
    }
    if (err instanceof CliError) return text(err.message, true);
    return text((err as Error).message, true);
  }
}

function tool(
  name: string,
  title: string,
  description: string,
  annotations: Json,
  inputSchema: Json,
  run: Tool['run'],
): Tool {
  return {
    name,
    group: null,
    description,
    inputSchema,
    annotations: { title, ...annotations },
    // Argument checks throw CliError. The protocol loop would report that as an internal error.
    run: async (io, args, structured) => {
      try {
        return await run(io, args, structured);
      } catch (err) {
        if (err instanceof CliError) return text(err.message, true);
        throw err;
      }
    },
  };
}

const idArg = { ...str, description: 'Id' };
const scopeArg = {
  ...str,
  description: 'org, key:<id>, sku:<provider>:<sku>, env:<name>, sess:<id> or agent:<id>',
};
const targetArg = { ...str, description: 'org, key:<id>, prov:<name> or sess:<id>' };
const pending =
  'A pending or pendingApproval field means a second person must approve it; it is not applied, so do not send it again.';

export const ADMIN_TOOLS: Tool[] = [
  tool(
    'keys_list',
    'List virtual keys',
    'List the virtual keys in the org. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/keys'),
  ),
  tool(
    'keys_show',
    'Show a virtual key',
    'Get one virtual key. The token is not included. Read-only.',
    READ,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'GET', `/v1/keys/${pathId(a.id, 'id')}`),
  ),
  tool(
    'keys_create',
    'Create a virtual key',
    'Create a virtual key. The token is in the result once; give it to the user. credentials maps a provider name to a provider-key id.',
    WRITE,
    schema(
      {
        name: str,
        credentials: { ...stringMap, description: 'provider name to provider-key id' },
        env: str,
        agent: { ...str, description: 'Agent id' },
        skus: { ...strings, description: 'Allowed SKUs. Omit for all.' },
        sessionCap: { ...usd, description: 'Budget for each session this key opens' },
        canMintSessions: { type: 'boolean' },
        expires: { ...str, description: 'Expiry, ISO 8601' },
        countries: { ...strings, description: 'Messaging destination countries, ISO alpha-2' },
      },
      ['name', 'credentials'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/keys', {
        name: a.name,
        credentials: a.credentials,
        ...(typeof a.env === 'string' ? { env: a.env } : {}),
        ...(typeof a.agent === 'string' ? { agentId: a.agent } : {}),
        ...(Array.isArray(a.skus) ? { skus: a.skus } : {}),
        ...(typeof a.sessionCap === 'string'
          ? { sessionCapMicros: usdToMicros(a.sessionCap).toString() }
          : {}),
        ...(typeof a.canMintSessions === 'boolean' ? { canMintSessions: a.canMintSessions } : {}),
        ...(typeof a.expires === 'string' ? { expiresAt: a.expires } : {}),
        ...(Array.isArray(a.countries)
          ? { countries: a.countries.map((c) => String(c).toUpperCase()) }
          : {}),
      }),
  ),
  tool(
    'keys_revoke',
    'Revoke a virtual key',
    'Revoke a virtual key. It can no longer spend.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/keys/${pathId(a.id, 'id')}`),
  ),
  tool(
    'keys_resume',
    'Resume a paused key',
    'Resume a key the loop breaker paused, and reset its repeat counts.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'POST', `/v1/keys/${pathId(a.id, 'id')}/resume`),
  ),
  tool('caps_list', 'List caps', 'List hard and soft caps. Read-only.', READ, none, (io, _a, s) =>
    admin(io, s, 'GET', '/v1/caps'),
  ),
  tool(
    'caps_set',
    'Set caps',
    `Set hard and soft caps for a scope, in dollars. Omit a window to leave it; within a window, a value left out keeps its current setting. To remove caps use caps_rm. ${pending}`,
    DESTROY,
    schema(
      {
        scope: scopeArg,
        day: { ...usd, description: 'Hard cap per day' },
        month: { ...usd, description: 'Hard cap per month' },
        softDay: { ...usd, description: 'Soft (alert-only) limit per day' },
        softMonth: { ...usd, description: 'Soft (alert-only) limit per month' },
      },
      ['scope'],
    ),
    async (io, a, s) => {
      const scope = scopeOf(a.scope);
      const body = await capsBody(io, a.scope as string, a);
      if (!body.day && !body.month) {
        throw new CliError('Give day and/or month, or a soft limit.', EXIT.usage);
      }
      return admin(io, s, 'PUT', `/v1/caps/${scope}`, body);
    },
  ),
  tool(
    'caps_rm',
    'Remove caps',
    `Remove a scope's caps. kind "d" or "m" removes one window. ${pending}`,
    DESTROY,
    schema({ scope: scopeArg, kind: { type: 'string', enum: ['d', 'm'] } }, ['scope']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/caps/${scopeOf(a.scope)}${query({ kind: a.kind })}`),
  ),
  tool(
    'kill',
    'Kill switch',
    'Stop all spend for an org, key, provider or session, immediately.',
    DESTROY,
    schema({ target: targetArg, reason: str }, ['target']),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/kill', {
        target: a.target,
        ...(a.reason ? { reason: a.reason } : {}),
      }),
  ),
  tool(
    'unkill',
    'Lift a kill',
    'Lift a kill so spending can resume.',
    DESTROY,
    schema({ target: targetArg, reason: str }, ['target']),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/unkill', {
        target: a.target,
        ...(a.reason ? { reason: a.reason } : {}),
      }),
  ),
  tool(
    'status',
    'Remaining budget',
    'Live remaining budget. Omit scopes for the org and every active key. Read-only.',
    READ,
    schema({ scopes: { ...strings, description: 'Scope labels, same form as caps' } }),
    (io, a, s) => admin(io, s, 'GET', `/v1/status${query({ scope: a.scopes })}`),
  ),
  tool(
    'spend',
    'Spend from the ledger',
    'Spend grouped by key, sku, day, provider, session, env or agent. days is the window when from is omitted (default 30). Read-only.',
    READ,
    schema({
      groupBy: {
        ...str,
        description: 'Comma-separated: key, sku, day, provider, session, env, agent',
      },
      days: { type: 'integer', minimum: 1, maximum: 366 },
      from: { ...str, description: 'ISO 8601 start' },
      to: { ...str, description: 'ISO 8601 end' },
    }),
    (io, a, s) =>
      admin(
        io,
        s,
        'GET',
        `/v1/spend${query({
          groupBy: typeof a.groupBy === 'string' ? a.groupBy : 'day',
          from:
            typeof a.from === 'string'
              ? a.from
              : new Date(Date.now() - num(a.days, 30) * 86_400_000).toISOString(),
          to: a.to,
        })}`,
        undefined,
        SLOW_MS,
      ),
  ),
  tool(
    'events',
    'Usage events',
    'Usage events, newest first, or the audit log with source "audit". limit defaults to 50 and is at most 200. Read-only.',
    READ,
    schema({
      source: { type: 'string', enum: ['usage', 'audit'] },
      type: str,
      keyId: str,
      from: str,
      to: str,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
      cursor: str,
    }),
    (io, a, s) =>
      admin(
        io,
        s,
        'GET',
        `/v1/events${query({
          source: a.source,
          type: a.type,
          keyId: a.keyId,
          from: a.from,
          to: a.to,
          limit: num(a.limit, 50),
          cursor: a.cursor,
        })}`,
        undefined,
        SLOW_MS,
      ),
  ),
  tool(
    'estimate',
    'Migration estimate',
    'Price the last N days of Google Maps usage on Geoapify, Stadia Maps, Open Places API, Mapbox and HERE. days defaults to 30. Read-only.',
    READ,
    schema({ days: { type: 'integer', minimum: 1, maximum: 90 } }),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/estimates/migration', { days: num(a.days, 30) }, SLOW_MS),
  ),
  tool(
    'custom_apis_list',
    'List custom APIs',
    'List custom APIs. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/custom-apis'),
  ),
  tool(
    'custom_apis_show',
    'Show a custom API',
    'Get one custom API. Read-only.',
    READ,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'GET', `/v1/custom-apis/${pathId(a.id, 'id')}`),
  ),
  tool(
    'custom_apis_add',
    'Add a custom API',
    'Add a custom API. definition is the custom API object, including its id. proxyPath, createdAt and updatedAt are ignored.',
    WRITE,
    schema({ definition: { ...jsonObj, description: 'Custom API definition' } }, ['definition']),
    (io, a, s) => admin(io, s, 'POST', '/v1/custom-apis', customApiBody(a.definition)),
  ),
  tool(
    'custom_apis_update',
    'Update a custom API',
    'Replace the definition of a custom API. The id in the path stays. A copy of custom_apis_show is accepted when its id matches. Its provider keys are sent to its origin: moving the origin needs moveOrigin: true.',
    EXPOSE,
    schema(
      {
        id: idArg,
        definition: {
          ...jsonObj,
          description: 'Replacement definition. Its id, if set, must match.',
        },
        moveOrigin: {
          type: 'boolean',
          description:
            'Confirms a new origin: every call then sends the provider key bound to this API there.',
        },
      },
      ['id', 'definition'],
    ),
    async (io, a, s) => {
      const id = pathId(a.id, 'id');
      const body = customApiBody(a.definition, a.id);
      const { data: now } = await apiExchange<{ origin: string }>(
        withTimeout(io, READ_MS),
        'GET',
        `/v1/custom-apis/${id}`,
      );
      const origin = (body as { origin?: unknown }).origin;
      if (
        typeof origin === 'string' &&
        hostOf(origin) !== hostOf(now.origin) &&
        a.moveOrigin !== true
      ) {
        throw new CliError(
          `The origin moves from ${now.origin} to ${origin}: the provider key bound to this API would be sent there. Pass moveOrigin: true to confirm.`,
          EXIT.usage,
        );
      }
      return admin(io, s, 'PUT', `/v1/custom-apis/${id}`, body);
    },
  ),
  tool(
    'custom_apis_delete',
    'Delete a custom API',
    'Delete a custom API and its provider keys. Refused while virtual keys use it.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/custom-apis/${pathId(a.id, 'id')}`),
  ),
  tool(
    'credentials_list',
    'List provider keys',
    'List provider keys. Secrets are not included. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/providers/credentials'),
  ),
  tool(
    'credentials_add',
    'Add a provider key',
    'Store a provider key. The secret is encrypted and is not in the result.',
    WRITE,
    schema(
      {
        provider: { ...str, description: 'Provider name, or a custom API id' },
        name: str,
        secret: { ...str, description: 'The provider key. It is not echoed back.' },
      },
      ['provider', 'name', 'secret'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/providers/credentials', {
        provider: a.provider,
        name: a.name,
        secret: a.secret,
      }),
  ),
  tool(
    'credentials_delete',
    'Delete a provider key',
    'Delete a provider key. Keys that use it move to another key of that provider, or the delete is refused.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/providers/credentials/${pathId(a.id, 'id')}`),
  ),
  tool(
    'webhooks_list',
    'List webhooks',
    'List alert webhooks. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/webhooks'),
  ),
  tool(
    'webhooks_add',
    'Add a webhook',
    'Add an alert webhook. The signing secret is in the result once. events: threshold, blocked, loop, catalog_underpriced, upstream_key_error, reservations_expired, reconcile_drift.',
    WRITE,
    schema(
      {
        name: str,
        url: str,
        preset: { type: 'string', enum: ['raw', 'slack', 'discord', 'teams'] },
        events: strings,
        secret: {
          ...str,
          description: 'Signing secret, at least 16 characters. Omit to have one generated.',
        },
      },
      ['name', 'url'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/webhooks', {
        name: a.name,
        url: a.url,
        ...(a.preset ? { preset: a.preset } : {}),
        ...(a.events ? { events: a.events } : {}),
        ...(a.secret ? { secret: a.secret } : {}),
      }),
  ),
  tool(
    'webhooks_delete',
    'Delete a webhook',
    'Delete an alert webhook.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/webhooks/${pathId(a.id, 'id')}`),
  ),
  tool(
    'webhooks_deliveries',
    'Webhook deliveries',
    'Delivery log of a webhook, newest first. limit defaults to 50 and is at most 200. Read-only.',
    READ,
    schema({ id: idArg, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['id']),
    (io, a, s) =>
      admin(
        io,
        s,
        'GET',
        `/v1/webhooks/${pathId(a.id, 'id')}/deliveries${query({ limit: num(a.limit, 50) })}`,
      ),
  ),
  tool(
    'telemetry_get',
    'Get OTLP export',
    'Where calls go as OpenTelemetry spans. Null when nowhere. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/telemetry/otlp'),
  ),
  tool(
    'telemetry_set',
    'Set OTLP export',
    'Send every call as a span to an OTLP/HTTP collector. The collector headers (often an API key) go to this endpoint: a new host needs its headers given again.',
    EXPOSE,
    schema(
      {
        endpoint: { ...str, description: 'OTLP/HTTP endpoint URL' },
        headers: {
          ...stringMap,
          description:
            'Collector headers; {} for none. Omit to keep the stored ones, only while the host stays the same.',
        },
        enabled: { type: 'boolean', description: 'Omit to keep the current setting' },
      },
      ['endpoint'],
    ),
    async (io, a, s) => {
      const { data } = await apiExchange<{ otlp: { endpoint: string; enabled: boolean } | null }>(
        withTimeout(io, READ_MS),
        'GET',
        '/v1/telemetry/otlp',
      );
      const now = data.otlp;
      // Stored headers are a secret the token cannot read: never let them follow a new host.
      if (now && !a.headers && hostOf(now.endpoint) !== hostOf(a.endpoint)) {
        throw new CliError(
          'The endpoint moves to another host: give headers again ({} for none). Stored headers are kept only for the same host.',
          EXIT.usage,
        );
      }
      return admin(io, s, 'PUT', '/v1/telemetry/otlp', {
        endpoint: a.endpoint,
        ...(a.headers ? { headers: a.headers } : {}),
        // The API turns export on when left out: keep a disabled export disabled.
        enabled: a.enabled !== undefined ? a.enabled : (now?.enabled ?? true),
      });
    },
  ),
  tool(
    'telemetry_delete',
    'Stop OTLP export',
    'Stop sending spans and drop the ones waiting.',
    DESTROY,
    none,
    (io, _a, s) => admin(io, s, 'DELETE', '/v1/telemetry/otlp'),
  ),
  tool(
    'telemetry_test',
    'Test OTLP export',
    'Send one test span to the configured collector now.',
    OUTBOUND,
    none,
    (io, _a, s) => admin(io, s, 'POST', '/v1/telemetry/otlp/test'),
  ),
  tool(
    'metrics',
    'Prometheus metrics',
    'Metrics for the org, in Prometheus text format. Cut at 100 KB. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/metrics', undefined, SLOW_MS, metricsText),
  ),
  tool(
    'org_get',
    'Get org settings',
    'Org name, time zone and policies. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/org'),
  ),
  tool(
    'sessions_mint',
    'Mint a session',
    'Mint a session key under a parent key. The session token is in the result once. budget and dayBudget are dollars (defaults $5 and $20). ttlSec defaults to 12 hours.',
    WRITE,
    schema(
      {
        parentKeyId: { ...str, description: 'Parent virtual key id' },
        budget: usd,
        dayBudget: usd,
        agent: str,
        ttlSec: { type: 'integer', minimum: 60, maximum: 7 * 24 * 3600 },
        name: str,
      },
      ['parentKeyId'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/sessions', {
        parentKeyId: a.parentKeyId,
        ...(typeof a.budget === 'string' ? { budgetMicros: usdToMicros(a.budget).toString() } : {}),
        ...(typeof a.dayBudget === 'string'
          ? { dayBudgetMicros: usdToMicros(a.dayBudget).toString() }
          : {}),
        ...(typeof a.agent === 'string' ? { agentId: a.agent } : {}),
        ...(typeof a.ttlSec === 'number' ? { ttlSec: a.ttlSec } : {}),
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
      }),
  ),
  tool(
    'sessions_end',
    'End a session',
    'Revoke a session key and report what it spent.',
    DESTROY,
    schema({ keyId: { ...str, description: 'The session key id' } }, ['keyId']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/sessions/${pathId(a.keyId, 'keyId')}`),
  ),
  tool(
    'approvals_list',
    'List approvals',
    'Cap raises waiting for, or decided by, a second person. Read-only. Needs the approvals feature.',
    READ,
    schema({ status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } }),
    (io, a, s) => admin(io, s, 'GET', `/v1/approvals${query({ status: a.status })}`),
  ),
  tool(
    'approvals_get_policy',
    'Get approval policy',
    'Whether raising or removing a hard cap needs a second person. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/approvals/policy'),
  ),
  tool(
    'approvals_approve',
    'Approve a cap raise',
    'Approve a waiting cap raise and apply it. A bearer token names no person, so SSO is required and the caller cannot be the requester.',
    WRITE,
    schema({ id: idArg, reason: str }, ['id']),
    (io, a, s) =>
      admin(io, s, 'POST', `/v1/approvals/${pathId(a.id, 'id')}/approve`, {
        ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
      }),
  ),
  tool(
    'approvals_reject',
    'Reject a cap raise',
    'Reject a waiting cap raise. A bearer token names no person, so SSO is required.',
    WRITE,
    schema({ id: idArg, reason: str }, ['id']),
    (io, a, s) =>
      admin(io, s, 'POST', `/v1/approvals/${pathId(a.id, 'id')}/reject`, {
        ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
      }),
  ),
  tool(
    'audit_export',
    'Export the audit log',
    'Audit log as JSON lines, oldest first, at most 200 lines. Narrow from and to for the rest. Needs the audit export feature.',
    READ,
    schema({
      from: { ...str, description: 'ISO 8601' },
      to: { ...str, description: 'ISO 8601' },
      cursor: str,
    }),
    (io, a, s) =>
      admin(
        io,
        s,
        'GET',
        `/v1/audit/export${query({ from: a.from, to: a.to, cursor: a.cursor })}`,
        undefined,
        SLOW_MS,
        auditLines,
      ),
  ),
  tool(
    'reconcile_status',
    'Reconciliation status',
    'Whether the ledger is compared with the Google billing export. Read-only. Needs the reconciliation feature.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/reconciliation'),
  ),
  tool(
    'reconcile_set',
    'Set reconciliation',
    'Compare the ledger with a Google Cloud Billing export table. serviceAccountJson is the read-only service account key (a JSON object or its text), not a file path.',
    WRITE,
    schema(
      {
        exportTable: { ...str, description: 'project.dataset.table' },
        serviceAccountJson: jsonArg(
          'Service account key JSON. It is not echoed back. Pass the value, not @file.',
        ),
        projectIds: { ...strings, description: 'Only these Google Cloud projects' },
      },
      ['exportTable', 'serviceAccountJson'],
    ),
    (io, a, s) =>
      admin(io, s, 'PUT', '/v1/reconciliation', {
        exportTable: a.exportTable,
        serviceAccountJson:
          typeof a.serviceAccountJson === 'string'
            ? a.serviceAccountJson
            : JSON.stringify(a.serviceAccountJson),
        projectIds: a.projectIds ?? [],
      }),
  ),
  tool(
    'reconcile_report',
    'Reconciliation report',
    'Daily comparison of the ledger with the billing export. Read-only.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/reconciliation/report', undefined, SLOW_MS),
  ),
  tool(
    'license_status',
    'License status',
    'Business or Enterprise license status. Read-only. A core install reports it missing.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/license'),
  ),
  tool('users_list', 'List people', 'People in the org. Admin or owner.', READ, none, (io, _a, s) =>
    admin(io, s, 'GET', '/v1/users'),
  ),
];

const loopSchema = {
  type: 'object',
  properties: {
    identical: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    windowSec: { type: 'integer', minimum: 1, maximum: 86_400 },
    perMinute: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    cooldownSec: { type: 'integer', minimum: 1, maximum: 86_400 },
  },
  required: ['identical', 'windowSec', 'perMinute', 'cooldownSec'],
  additionalProperties: false,
};

export const OWNER_TOOLS: Tool[] = [
  tool(
    'approvals_set_policy',
    'Set approval policy',
    `Turn the two-person rule on or off. Owner. Turning it off is itself a request another owner approves, and needs SSO (a bearer token names no person). ${pending}`,
    WRITE,
    schema({ capApprovals: { type: 'boolean' } }, ['capApprovals']),
    (io, a, s) => admin(io, s, 'PUT', '/v1/approvals/policy', { capApprovals: a.capApprovals }),
  ),
  tool(
    'org_update',
    'Update org settings',
    'Update the org name, time zone, alert email, raise-link rule, loop rule or provider policy. Owner.',
    DESTROY,
    schema({
      name: str,
      timeZone: str,
      alertEmail: { type: ['string', 'null'], description: 'Null clears it' },
      requireLoginForRaise: { type: 'boolean' },
      loop: loopSchema,
      providers: { ...jsonObj, description: 'Provider pricing policy, as PUT /v1/org expects' },
    }),
    (io, a, s) => {
      const body: Json = {};
      for (const k of [
        'name',
        'timeZone',
        'alertEmail',
        'requireLoginForRaise',
        'loop',
        'providers',
      ]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      if (!Object.keys(body).length) throw new CliError('Give a setting to change.', EXIT.usage);
      return admin(io, s, 'PUT', '/v1/org', body);
    },
  ),
  tool(
    'tokens_list',
    'List admin tokens',
    'List admin API tokens. The secrets are not included. Owner.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/tokens'),
  ),
  tool(
    'tokens_create',
    'Create an admin token',
    'Create an admin API token. The token is in the result once. Owner.',
    WRITE,
    schema(
      {
        name: str,
        role: { type: 'string', enum: [...ROLES] },
        expires: { ...str, description: 'Expiry, ISO 8601' },
      },
      ['name', 'role'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/tokens', {
        name: a.name,
        role: a.role,
        ...(a.expires ? { expiresAt: a.expires } : {}),
      }),
  ),
  tool(
    'tokens_revoke',
    'Revoke an admin token',
    'Revoke an admin API token. Owner.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/tokens/${pathId(a.id, 'id')}`),
  ),
  tool(
    'users_invite',
    'Invite a person',
    'Invite a person. Emails a sign-in link when email sign-in is on. Owner.',
    WRITE,
    schema({ email: str, role: { type: 'string', enum: [...ROLES] } }, ['email', 'role']),
    (io, a, s) => admin(io, s, 'POST', '/v1/users', { email: a.email, role: a.role }),
  ),
  tool(
    'users_update',
    'Change the role of a person',
    'Change the role of a person. Their sessions end. Owner.',
    DESTROY,
    schema({ id: idArg, role: { type: 'string', enum: [...ROLES] } }, ['id', 'role']),
    (io, a, s) => admin(io, s, 'PATCH', `/v1/users/${pathId(a.id, 'id')}`, { role: a.role }),
  ),
  tool(
    'users_delete',
    'Remove a person',
    'Remove a person. Their sessions end. Owner.',
    DESTROY,
    schema({ id: idArg }, ['id']),
    (io, a, s) => admin(io, s, 'DELETE', `/v1/users/${pathId(a.id, 'id')}`),
  ),
  tool(
    'license_install',
    'Install a license',
    'Install a Business or Enterprise license. license is the JSON text of the license file, not a path. Owner of the licensed org.',
    DESTROY,
    schema({ license: { ...str, description: 'The license file contents' } }, ['license']),
    (io, a, s) => admin(io, s, 'POST', '/v1/license', { license: a.license }),
  ),
  tool(
    'sso_get',
    'Get single sign-on',
    'Single sign-on configuration, without the client secret. Owner.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/sso'),
  ),
  tool(
    'sso_set',
    'Configure single sign-on',
    'Configure OIDC or SAML. config is the PUT /v1/sso body: protocol "oidc" (issuer, clientId, clientSecret) or "saml" (entryPoint, idpCert), plus roleMap. The client secret is not in later reads. Owner.',
    DESTROY,
    schema({ config: { ...jsonObj, description: 'OIDC or SAML configuration' } }, ['config']),
    (io, a, s) => admin(io, s, 'PUT', '/v1/sso', a.config),
  ),
  tool(
    'sso_delete',
    'Turn single sign-on off',
    'Turn single sign-on off and revoke the tokens it issued. Refused while two-person approval is on. Owner.',
    DESTROY,
    none,
    (io, _a, s) => admin(io, s, 'DELETE', '/v1/sso'),
  ),
  tool(
    'roles_list',
    'List extra roles',
    'Roles beyond owner, admin and viewer, and what each may do. Read-only. Needs the RBAC feature.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/roles'),
  ),
  tool(
    'roles_create_token',
    'Create a role token',
    'Create an operator, billing or auditor token. The token is in the result once. Owner. Needs the RBAC feature.',
    WRITE,
    schema(
      {
        name: str,
        role: { type: 'string', enum: ['operator', 'billing', 'auditor'] },
        expires: { ...str, description: 'Expiry, ISO 8601' },
      },
      ['name', 'role'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/roles/tokens', {
        name: a.name,
        role: a.role,
        ...(a.expires ? { expiresAt: a.expires } : {}),
      }),
  ),
  tool(
    'orgs_list',
    'List orgs',
    'Orgs on this install. Owners of the licensed org. Read-only. Needs the multi-org feature.',
    READ,
    none,
    (io, _a, s) => admin(io, s, 'GET', '/v1/orgs'),
  ),
  tool(
    'orgs_create',
    'Create an org',
    'Create another org. The owner token of the new org is in the result once. Needs the multi-org feature.',
    WRITE,
    schema(
      {
        id: { ...str, description: 'Org id' },
        name: str,
        timeZone: { ...str, description: 'Default UTC' },
      },
      ['id', 'name'],
    ),
    (io, a, s) =>
      admin(io, s, 'POST', '/v1/orgs', {
        id: a.id,
        name: a.name,
        ...(a.timeZone ? { timeZone: a.timeZone } : {}),
      }),
  ),
];
