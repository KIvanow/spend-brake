import type { Me } from '../../admin.js';
import {
  CliError,
  EXIT,
  type Io,
  config,
  keyHeaders,
  microsToUsd,
  timedOut,
  withTimeout,
} from '../../io.js';
import { type ProxyRequest, proxyCall, refusal } from '../../proxy.js';
import { callRequest } from '../call.js';
import { DEFAULT_FIELDS, mapsRequest } from '../maps.js';
import { searchRequest } from '../search.js';
import { type Json, type Tool, type ToolResult, jsonArg, result, text } from './protocol.js';

export const SPEND_GROUPS = ['tavily', 'exa', 'brave', 'serpapi', 'maps', 'call'] as const;

export const SPEND_INSTRUCTIONS =
  'Every tool except brake_budget is charged against a hard dollar cap. When a tool answers with ' +
  'STOP, do not retry and do not switch to another tool: the same caps apply to all of them. Tell ' +
  'the user and ask them to raise the cap. A call that timed out may already have been forwarded ' +
  'and charged: check brake_budget before calling again. Prefer the named search and maps tools ' +
  'over brake_call; their defaults are the cheap SKUs, and a wider field mask or a deeper search ' +
  'costs more.';

const str = { type: 'string' };
const strings = { type: 'array', items: { type: 'string' } };
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };

const SPEND = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** How long a tool call waits for an answer before it reports one never came. */
const CALL_TIMEOUT_MS = 60_000;
const ME_TIMEOUT_MS = 10_000;

const TIMED_OUT = (proxyUrl: string) =>
  `STOP. No answer from the proxy at ${proxyUrl} within ${CALL_TIMEOUT_MS / 1000} s. The call may already have been forwarded and charged: do not retry it blindly. Check brake_budget first, and ask the user before calling again.`;

const NO_KEY =
  'BRAKE_KEY is not set for this MCP server: add a Spend Brake virtual key to the "env" of its entry in the MCP configuration.';

/** The provider's own error, short enough for the model to read and fix its arguments. */
function excerpt(data: unknown): string {
  let s: string;
  if (typeof data === 'string') s = data;
  else if (typeof data === 'object' && data !== null) {
    const o = data as Record<string, unknown>;
    const field = [o.detail, o.message, o.error].find((v) => v !== undefined && v !== null);
    s = typeof field === 'string' ? field : JSON.stringify(field ?? o);
  } else return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

async function runProxy(
  io: Io,
  build: () => ProxyRequest,
  structured: boolean,
): Promise<ToolResult> {
  let req: ProxyRequest;
  try {
    req = build();
  } catch (err) {
    if (err instanceof CliError) return text(`Invalid arguments: ${err.message}.`, true);
    throw err;
  }
  const cfg = config(io);
  if (!cfg.key) return text(NO_KEY, true);
  let r;
  try {
    r = await proxyCall(withTimeout(io, CALL_TIMEOUT_MS), req);
  } catch (err) {
    // The proxy may have forwarded it (Exa bills a call that times out): never invite a retry.
    if (timedOut(err)) return text(TIMED_OUT(cfg.proxyUrl), true);
    return text(err instanceof CliError ? err.message : (err as Error).message, true);
  }
  const why = refusal(r);
  if (why) {
    // A STOP says all there is to say; any other failure carries the provider's own error, so
    // the model can fix its arguments.
    const more = why.code === EXIT.error && !why.message.startsWith('STOP') ? excerpt(r.data) : '';
    return text(
      more && !why.message.includes(more) ? `${why.message} (provider said: ${more})` : why.message,
      true,
    );
  }
  return result(
    {
      cost: r.cost,
      remaining: r.remainingMicros === null ? null : microsToUsd(r.remainingMicros),
      result: r.data,
    },
    structured,
  );
}

async function budget(io: Io, structured: boolean): Promise<ToolResult> {
  const cfg = config(io);
  if (!cfg.key) return text(NO_KEY, true);
  let me: Me;
  try {
    const res = await withTimeout(io, ME_TIMEOUT_MS).fetch(`${cfg.apiUrl}/v1/me`, {
      headers: keyHeaders(cfg),
    });
    if (res.status === 401 || res.status === 403) {
      return text(`The key was refused (HTTP ${res.status}): unknown, revoked or expired.`, true);
    }
    if (!res.ok) {
      // The server's reason when it gives one, such as a refused X-Brake-Session.
      const e = (await res.json().catch(() => ({}))) as { message?: unknown };
      return text(
        typeof e.message === 'string' && res.status < 500
          ? `The budget was refused (HTTP ${res.status}): ${e.message}`
          : `The budget is unavailable right now (HTTP ${res.status}).`,
        true,
      );
    }
    me = (await res.json()) as Me;
  } catch (err) {
    return text(`cannot reach the admin API at ${cfg.apiUrl}: ${(err as Error).message}`, true);
  }
  return result(
    {
      killed: me.killed,
      // Providers switched off on their own: calls to them stop even while killed is false.
      killedProviders: me.killedProviders ?? [],
      // A key sees its own, its session's, its parent's and its agent's caps, not these.
      notShown: 'Org, environment and SKU caps also apply and are not visible to a key.',
      caps: me.scopes
        .filter((s) => s.hard !== null)
        .map((s) => ({
          scope: s.scope,
          window: s.window,
          cap: microsToUsd(s.hard!, 2),
          spent: microsToUsd(s.spent),
          held: microsToUsd(s.held),
          remaining: microsToUsd(s.remaining ?? 0),
        })),
    },
    structured,
  );
}

function schema(properties: Json, required: string[]): Json {
  return { type: 'object', properties, required, additionalProperties: false };
}

function spend(
  name: string,
  group: string,
  title: string,
  description: string,
  inputSchema: Json,
  build: (args: Json) => ProxyRequest,
): Tool {
  return {
    name,
    group,
    description,
    inputSchema,
    annotations: { title, ...SPEND },
    run: (io, args, structured) => runProxy(io, () => build(args), structured),
  };
}

const tavilySchema = schema(
  {
    query: { ...str, description: 'What to search for' },
    search_depth: {
      type: 'string',
      enum: ['basic', 'fast', 'ultra-fast', 'advanced'],
      description: 'basic (default) costs 1 credit; advanced costs 2',
    },
    max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 5' },
    topic: { type: 'string', enum: ['general', 'news', 'finance'] },
    time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
    include_domains: { ...strings, description: 'Only these domains' },
    exclude_domains: { ...strings, description: 'Never these domains' },
    include_answer: { type: 'boolean', description: 'Add a short generated answer' },
  },
  ['query'],
);

const exaSchema = schema(
  {
    query: { ...str, description: 'What to search for' },
    type: {
      type: 'string',
      enum: ['auto', 'fast', 'instant', 'lite', 'deep'],
      description: 'auto (default); lite and instant are cheaper, deep costs more',
    },
    numResults: {
      type: 'integer',
      minimum: 1,
      maximum: 25,
      description: 'Default 5; each result above 10 costs extra',
    },
    includeDomains: { ...strings, description: 'Only these domains' },
    excludeDomains: { ...strings, description: 'Never these domains' },
    startPublishedDate: { ...str, description: 'ISO date, e.g. 2026-01-01' },
    text: { type: 'boolean', description: "Include each page's text (costs extra per result)" },
  },
  ['query'],
);

function withExtras(
  body: Record<string, unknown>,
  args: Json,
  keys: string[],
): Record<string, unknown> {
  const out = { ...body };
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

const fields = {
  ...str,
  description: 'X-Goog-FieldMask. The default is the cheapest useful set; a wider mask costs more.',
};

export const SPEND_TOOLS: Tool[] = [
  spend(
    'tavily_search',
    'tavily',
    'Tavily search (capped)',
    'Search the web with Tavily. Each call is charged against a hard spend cap; the result shows its cost and the budget left. basic depth is the cheap default.',
    tavilySchema,
    (args) => {
      const req = searchRequest('tavily', args.query as string, {
        depth: (args.search_depth as string | undefined) ?? 'basic',
        results: String((args.max_results as number | undefined) ?? 5),
      });
      return {
        ...req,
        body: withExtras(req.body as Record<string, unknown>, args, [
          'topic',
          'time_range',
          'include_domains',
          'exclude_domains',
          'include_answer',
        ]),
      };
    },
  ),
  spend(
    'exa_search',
    'exa',
    'Exa search (capped)',
    'Search the web with Exa. Each call is charged against a hard spend cap; the result shows its cost and the budget left. type auto is the default; lite and instant are cheaper.',
    exaSchema,
    (args) => {
      const req = searchRequest('exa', args.query as string, {
        type: (args.type as string | undefined) ?? 'auto',
        results: String((args.numResults as number | undefined) ?? 5),
      });
      const body = withExtras(req.body as Record<string, unknown>, args, [
        'includeDomains',
        'excludeDomains',
        'startPublishedDate',
      ]);
      if (args.text === true) body.contents = { text: true };
      return { ...req, body };
    },
  ),
  spend(
    'brave_search',
    'brave',
    'Brave search (capped)',
    'Search the web with Brave. Each call is charged against a hard spend cap; the result shows its cost and the budget left.',
    schema(
      {
        query: { ...str, description: 'What to search for' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of results' },
      },
      ['query'],
    ),
    (args) =>
      searchRequest('brave', args.query as string, {
        ...(args.count !== undefined ? { results: String(args.count) } : {}),
      }),
  ),
  spend(
    'serpapi_search',
    'serpapi',
    'SerpApi search (capped)',
    'Search with SerpApi. Each call is charged against a hard spend cap; the result shows its cost and the budget left. engine defaults to google.',
    schema(
      {
        query: { ...str, description: 'What to search for' },
        engine: { ...str, description: 'SerpApi engine. Default google.' },
        num: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of results' },
      },
      ['query'],
    ),
    (args) =>
      searchRequest('serpapi', args.query as string, {
        engine: (args.engine as string | undefined) ?? 'google',
        ...(args.num !== undefined ? { results: String(args.num) } : {}),
      }),
  ),
  spend(
    'maps_search',
    'maps',
    'Places text search (capped)',
    `Places Text Search. Default field mask ${DEFAULT_FIELDS.search} (IDs only, the free tier). A wider mask costs more.`,
    schema(
      {
        query: { ...str, description: 'What to look up' },
        fields,
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Page size' },
      },
      ['query'],
    ),
    (args) =>
      mapsRequest({
        op: 'search',
        query: args.query as string,
        ...(args.fields ? { fields: args.fields as string } : {}),
        ...(args.limit !== undefined ? { limit: String(args.limit) } : {}),
      }),
  ),
  spend(
    'maps_nearby',
    'maps',
    'Places nearby search (capped)',
    `Places Nearby Search around a point. Default field mask ${DEFAULT_FIELDS.nearby} (Pro). A wider mask costs more. radius defaults to 500 metres.`,
    schema(
      {
        lat: { ...str, description: 'Latitude' },
        lng: { ...str, description: 'Longitude' },
        radius: {
          type: 'integer',
          minimum: 1,
          maximum: 50_000,
          description: 'Metres. Default 500.',
        },
        type: { ...strings, description: 'Included place types' },
        fields,
      },
      ['lat', 'lng'],
    ),
    (args) =>
      mapsRequest({
        op: 'nearby',
        lat: args.lat as string,
        lng: args.lng as string,
        ...(args.radius !== undefined ? { radius: String(args.radius) } : {}),
        ...(args.type ? { type: args.type as string[] } : {}),
        ...(args.fields ? { fields: args.fields as string } : {}),
      }),
  ),
  spend(
    'maps_details',
    'maps',
    'Place details (capped)',
    `Place Details. Default field mask ${DEFAULT_FIELDS.details} (Essentials). A wider mask costs more.`,
    schema(
      {
        placeId: { ...str, description: 'A Google place id' },
        fields,
      },
      ['placeId'],
    ),
    (args) =>
      mapsRequest({
        op: 'details',
        placeId: args.placeId as string,
        ...(args.fields ? { fields: args.fields as string } : {}),
      }),
  ),
  spend(
    'maps_geocode',
    'maps',
    'Geocode (capped)',
    'Address to coordinates (Geocoding API). Charged against the spend cap.',
    schema({ address: { ...str, description: 'The address' } }, ['address']),
    (args) => mapsRequest({ op: 'geocode', address: args.address as string }),
  ),
  spend(
    'maps_reverse',
    'maps',
    'Reverse geocode (capped)',
    'Coordinates to an address (Geocoding API). Charged against the spend cap.',
    schema(
      {
        lat: { ...str, description: 'Latitude' },
        lng: { ...str, description: 'Longitude' },
      },
      ['lat', 'lng'],
    ),
    (args) => mapsRequest({ op: 'reverse', lat: args.lat as string, lng: args.lng as string }),
  ),
  spend(
    'maps_route',
    'maps',
    'Route (capped)',
    `Route between two places. Default field mask ${DEFAULT_FIELDS.route} (Essentials). mode defaults to drive. A wider mask costs more.`,
    schema(
      {
        origin: { ...str, description: 'Address, or "lat,lng"' },
        destination: { ...str, description: 'Address, or "lat,lng"' },
        mode: { type: 'string', enum: ['drive', 'walk', 'bicycle', 'transit'] },
        fields,
      },
      ['origin', 'destination'],
    ),
    (args) =>
      mapsRequest({
        op: 'route',
        origin: args.origin as string,
        destination: args.destination as string,
        ...(args.mode ? { mode: args.mode as string } : {}),
        ...(args.fields ? { fields: args.fields as string } : {}),
      }),
  ),
  {
    name: 'brake_call',
    group: 'call',
    description:
      'Any capped request the proxy prices: Mapbox, HERE, Twilio, Tavily extract, Exa contents, a custom API (provider "custom/<id>"), or a Maps call the named tools do not cover. This can select an expensive SKU. Prefer the named search and maps tools, which default to the cheap field set. Charged against the spend cap. No file reads.',
    inputSchema: schema(
      {
        provider: {
          ...str,
          description:
            'Proxy prefix: google-maps, google-places, google-routes, mapbox, brave, tavily, exa, serpapi, twilio, twilio-verify, here-geocode, here-revgeocode, here-discover, here-autosuggest, here-autocomplete, here-router, here-matrix, or custom/<id>',
        },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { ...str, description: 'Path on the provider, starting with /' },
        query: { ...stringMap, description: 'Query parameters' },
        headers: {
          ...stringMap,
          description: 'Extra headers. X-Brake-* is refused; the key comes from BRAKE_KEY.',
        },
        body: jsonArg('JSON body. Pass the value, not @file.'),
      },
      ['provider', 'method', 'path'],
    ),
    annotations: { title: 'Capped provider call', ...SPEND },
    run: (io, args, structured) => {
      const headers = args.headers as Record<string, string> | undefined;
      if (headers) {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase().startsWith('x-brake-')) {
            return Promise.resolve(
              text(`Invalid arguments: ${k} is set by the server from BRAKE_KEY.`, true),
            );
          }
        }
      }
      return runProxy(
        io,
        () =>
          callRequest(args.provider as string, args.method as string, args.path as string, {
            ...(args.query ? { query: args.query as Record<string, string> } : {}),
            ...(headers ? { headers } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
          }),
        structured,
      );
    },
  },
  {
    name: 'brake_budget',
    group: null,
    description:
      'Show the spend caps that apply to this key and what is left of each. Read-only: it cannot change a cap. Org, environment and SKU caps also apply and are not listed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Remaining budget', readOnlyHint: true, openWorldHint: false },
    run: (io, _args, structured) => budget(io, structured),
  },
];
