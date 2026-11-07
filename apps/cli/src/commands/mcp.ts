import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { CliError, EXIT, type Io, config, microsToUsd } from '../io.js';
import { VERSION } from '../version.js';
import { type ProxyRequest, proxyCall, refusal } from '../proxy.js';

/** Newest first; an unknown client version gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'Web search through Spend Brake: every call is charged against a hard dollar cap. When a tool ' +
  'answers with STOP, do not retry or work around it; tell the user and ask them to raise the ' +
  'cap. brake_budget shows what is left.';

type Json = Record<string, unknown>;

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Json;
}

interface Tool {
  name: string;
  provider: string | null;
  description: string;
  inputSchema: Json;
  annotations: Json;
  /** Checked arguments to a proxy request, or a message for the model to correct them. */
  build?: (args: Json) => ProxyRequest | string;
}

const str = { type: 'string' };
const strings = { type: 'array', items: { type: 'string' } };

/** Copies the arguments the schema names, checking each; returns a message on the first bad one. */
function pick(args: Json, schema: Json): Json | string {
  const props = schema.properties as Record<string, Json>;
  for (const k of (schema.required as string[] | undefined) ?? []) {
    if (args[k] === undefined) return `${k} is required`;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) return `unknown argument ${k}`;
    if (p.type === 'string' && (typeof v !== 'string' || !v.trim()))
      return `${k} must be a non-empty string`;
    if (p.enum && !(p.enum as unknown[]).includes(v))
      return `${k} must be one of ${(p.enum as string[]).join(', ')}`;
    if (p.type === 'integer') {
      if (
        !Number.isInteger(v) ||
        (v as number) < (p.minimum as number) ||
        (v as number) > (p.maximum as number)
      ) {
        return `${k} must be an integer from ${p.minimum as number} to ${p.maximum as number}`;
      }
    }
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`;
    if (p.type === 'array' && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      return `${k} must be a list of strings`;
    }
    out[k] = v;
  }
  return out;
}

const tavilySchema = {
  type: 'object',
  properties: {
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
  required: ['query'],
  additionalProperties: false,
};

const exaSchema = {
  type: 'object',
  properties: {
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
  required: ['query'],
  additionalProperties: false,
};

const TOOLS: Tool[] = [
  {
    name: 'tavily_search',
    provider: 'tavily',
    description:
      'Search the web with Tavily. Each call is charged against a hard spend cap; the result shows its cost and the budget left.',
    inputSchema: tavilySchema,
    annotations: { title: 'Tavily search (capped)', readOnlyHint: true, openWorldHint: true },
    build: (args) => {
      const a = pick(args, tavilySchema);
      if (typeof a === 'string') return a;
      return {
        method: 'POST',
        path: '/tavily/search',
        body: { search_depth: 'basic', max_results: 5, ...a },
      };
    },
  },
  {
    name: 'exa_search',
    provider: 'exa',
    description:
      'Search the web with Exa. Each call is charged against a hard spend cap; the result shows its cost and the budget left.',
    inputSchema: exaSchema,
    annotations: { title: 'Exa search (capped)', readOnlyHint: true, openWorldHint: true },
    build: (args) => {
      const a = pick(args, exaSchema);
      if (typeof a === 'string') return a;
      const { text, ...rest } = a;
      return {
        method: 'POST',
        path: '/exa/search',
        body: {
          type: 'auto',
          numResults: 5,
          ...rest,
          ...(text ? { contents: { text: true } } : {}),
        },
      };
    },
  },
  {
    name: 'brake_budget',
    provider: null,
    description:
      'Show the spend caps that apply to this key and what is left of each. Read-only: it cannot change a cap.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Remaining budget', readOnlyHint: true, openWorldHint: false },
  },
];

const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(isError ? { isError } : {}),
});

const result = (data: Json, structured: boolean): ToolResult => ({
  ...text(JSON.stringify(data)),
  ...(structured ? { structuredContent: data } : {}),
});

interface Me {
  keyId: string;
  sessionId: string | null;
  killed: boolean;
  scopes: {
    scope: string;
    window: string;
    spent: number;
    held: number;
    hard: number | null;
    remaining: number | null;
  }[];
}

async function budget(io: Io, structured: boolean): Promise<ToolResult> {
  const cfg = config(io);
  if (!cfg.key) return text('BRAKE_KEY is not set for this MCP server.', true);
  let me: Me;
  try {
    const res = await io.fetch(`${cfg.apiUrl}/v1/me`, {
      headers: {
        'x-brake-key': cfg.key,
        ...(cfg.session ? { 'x-brake-session': cfg.session } : {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      return text(`The key was refused (HTTP ${res.status}): unknown, revoked or expired.`, true);
    }
    if (!res.ok) return text(`The budget is unavailable right now (HTTP ${res.status}).`, true);
    me = (await res.json()) as Me;
  } catch (err) {
    return text(`cannot reach the admin API at ${cfg.apiUrl}: ${(err as Error).message}`, true);
  }
  return result(
    {
      killed: me.killed,
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

async function callTool(io: Io, tool: Tool, args: Json, structured: boolean): Promise<ToolResult> {
  if (!tool.build) {
    const bad = pick(args, tool.inputSchema);
    return typeof bad === 'string'
      ? text(`Invalid arguments: ${bad}.`, true)
      : budget(io, structured);
  }
  const req = tool.build(args);
  if (typeof req === 'string') return text(`Invalid arguments: ${req}.`, true);
  let r;
  try {
    r = await proxyCall(io, req);
  } catch (err) {
    return text(err instanceof CliError ? err.message : (err as Error).message, true);
  }
  const why = refusal(r);
  if (why) return text(why.message, true);
  return result(
    {
      cost: r.cost,
      remaining: r.remainingMicros === null ? null : microsToUsd(r.remainingMicros),
      result: r.data,
    },
    structured,
  );
}

interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

/** Serve MCP on stdin/stdout until stdin closes. stdout carries protocol messages only. */
export async function serveMcp(io: Io, tools: Tool[]): Promise<void> {
  if (!io.stdin) throw new CliError('brake mcp needs stdin');
  let structured = true;
  const send = (m: Json) => io.stdout(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const fail = (id: Message['id'], code: number, message: string) =>
    send({ id: id ?? null, error: { code, message } });

  async function handle(line: string) {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return fail(null, -32700, 'Parse error');
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return fail(null, -32600, 'Invalid request');
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest ? fail(msg.id, -32600, 'Invalid request') : undefined;
    }
    // Notifications (initialized, cancelled) need no answer.
    if (!isRequest) return undefined;
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const version =
          typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0]!;
        // structuredContent arrived in 2025-06-18.
        structured = version >= '2025-06-18';
        return send({
          id: msg.id,
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: {
              name: 'spend-brake',
              title: 'Spend Brake capped search',
              version: VERSION,
            },
            instructions: INSTRUCTIONS,
          },
        });
      }
      case 'ping':
        return send({ id: msg.id, result: {} });
      case 'tools/list':
        return send({
          id: msg.id,
          result: {
            tools: tools.map(({ name, description, inputSchema, annotations }) => ({
              name,
              title: annotations.title,
              description,
              inputSchema,
              annotations,
            })),
          },
        });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          return send({ id: msg.id, result: text('Invalid arguments: expected an object.', true) });
        }
        let res: ToolResult;
        try {
          res = await callTool(io, tool, args as Json, structured);
        } catch (err) {
          // Answer the request whatever went wrong, so the client is never left waiting.
          return fail(msg.id, -32603, `Internal error: ${(err as Error).message}`);
        }
        return send({ id: msg.id, result: res });
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  const pending = new Set<Promise<unknown>>();
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const p = handle(line).catch((err: unknown) => {
      io.stderr(`brake mcp: ${(err as Error).message}\n`);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}

export function mcpCommand(program: Command, io: Io, done: (code: number) => void): void {
  program
    .command('mcp')
    .description('MCP server on stdio: capped Tavily and Exa search, and a read-only budget tool')
    .option(
      '--tools <list>',
      'search providers to offer: tavily, exa (comma-separated)',
      'tavily,exa',
    )
    .action(async (o: { tools: string }) => {
      const want = o.tools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const known = TOOLS.flatMap((t) => (t.provider ? [t.provider] : []));
      const bad = want.filter((w) => !known.includes(w));
      if (bad.length || want.length === 0) {
        throw new CliError(`--tools takes ${known.join(', ')}`, EXIT.usage);
      }
      await serveMcp(
        io,
        TOOLS.filter((t) => t.provider === null || want.includes(t.provider)),
      );
      done(EXIT.ok);
    });
}
