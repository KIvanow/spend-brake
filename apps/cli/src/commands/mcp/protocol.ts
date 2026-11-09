import { createInterface } from 'node:readline';
import { CliError, type Io } from '../../io.js';
import { VERSION } from '../../version.js';

/** Newest first; an unknown client version gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type Json = Record<string, unknown>;

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Json;
}

export interface Tool {
  name: string;
  /** Spend group (`tavily`, `maps`, …). Null is listed whenever the profile is. */
  group: string | null;
  description: string;
  inputSchema: Json;
  annotations: Json;
  run: (io: Io, args: Json, structured: boolean) => Promise<ToolResult>;
}

export const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(isError ? { isError } : {}),
});

export const result = (data: Json, structured: boolean): ToolResult => ({
  ...text(JSON.stringify(data)),
  ...(structured ? { structuredContent: data } : {}),
});

/** A checked value. An error is not a string: a successful argument can be one. */
type Checked = { ok: true; value: unknown } | { ok: false; error: string };

const good = (value: unknown): Checked => ({ ok: true, value });
const bad = (error: string): Checked => ({ ok: false, error });

/**
 * Copies the arguments the schema names. Returns a message on the first bad one.
 * Own properties only: `constructor` and `toString` are not arguments.
 */
export function pick(args: Json, schema: Json): Json | string {
  const props = (schema.properties ?? {}) as Record<string, Json>;
  for (const k of (schema.required as string[] | undefined) ?? []) {
    if (args[k] === undefined) return `${k} is required`;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    const p = Object.hasOwn(props, k) ? props[k] : undefined;
    if (!p) return `unknown argument ${k}`;
    const checked = checkProp(k, v, p);
    if (!checked.ok) return checked.error;
    out[k] = checked.value;
  }
  return out;
}

function checkProp(k: string, v: unknown, p: Json): Checked {
  // `type: ["string", "null"]`: null is a value of its own (it clears a setting).
  const types = Array.isArray(p.type) ? (p.type as string[]) : [p.type as string];
  if (v === null && types.includes('null')) return good(null);
  if (types.includes('string') && (typeof v !== 'string' || !v.trim())) {
    return bad(`${k} must be a non-empty string`);
  }
  if (p.enum && !(p.enum as unknown[]).includes(v)) {
    return bad(`${k} must be one of ${(p.enum as string[]).join(', ')}`);
  }
  if (p.type === 'integer') {
    if (
      !Number.isInteger(v) ||
      (v as number) < (p.minimum as number) ||
      (v as number) > (p.maximum as number)
    ) {
      return bad(`${k} must be an integer from ${p.minimum as number} to ${p.maximum as number}`);
    }
  }
  if (p.type === 'boolean' && typeof v !== 'boolean') return bad(`${k} must be true or false`);
  if (
    p.type === 'array' &&
    (!Array.isArray(v) || (v as unknown[]).some((x) => typeof x !== 'string'))
  ) {
    return bad(`${k} must be a list of strings`);
  }
  if (p.type === 'object') return checkObject(k, v, p);
  // Set by jsonArg. Any other anyOf is a real union and is not "any JSON".
  if (isJsonValue(p)) return checkJson(k, v);
  return good(v);
}

/** Not a schema keyword: `tools/list` must publish plain JSON Schema. */
const JSON_VALUE = Symbol('json');

/** JSON Schema for any JSON value. `pick` refuses a string that starts with `@`. */
export function jsonArg(description: string): Json {
  return {
    description,
    anyOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ],
    [JSON_VALUE]: true,
  };
}

function isJsonValue(p: Json): boolean {
  return (p as { [JSON_VALUE]?: true })[JSON_VALUE] === true;
}

function checkObject(k: string, v: unknown, p: Json): Checked {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad(`${k} must be an object`);
  if (p.properties) {
    const nested = pick(v as Json, p);
    return typeof nested === 'string' ? bad(`${k}: ${nested}`) : good(nested);
  }
  const add = p.additionalProperties as Json | boolean | undefined;
  if (typeof add === 'object' && add.type === 'string') {
    const rec: Record<string, string> = {};
    for (const [kk, vv] of Object.entries(v)) {
      if (typeof vv !== 'string') return bad(`${k}.${kk} must be a string`);
      rec[kk] = vv;
    }
    return good(rec);
  }
  // A free JSON object (a custom API definition, an SSO config). The API checks its fields.
  return good(v);
}

function checkJson(k: string, v: unknown): Checked {
  if (typeof v === 'string' && v.startsWith('@')) return bad(`${k} cannot read a file; pass JSON`);
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    Array.isArray(v) ||
    typeof v === 'object'
  ) {
    return good(v);
  }
  return bad(`${k} must be JSON`);
}

interface Message {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Json;
}

/** Serve MCP on stdin/stdout until stdin closes. stdout carries protocol messages only. */
export async function serveMcp(
  io: Io,
  tools: Tool[],
  profile: { title: string; instructions: string },
): Promise<void> {
  if (!io.stdin) throw new CliError('brake mcp needs stdin');
  let structured = true;
  // JSON-RPC batches: in 2025-03-26 (and before), not since 2025-06-18.
  let batches = true;
  const reply = (m: Json): Json => ({ jsonrpc: '2.0', ...m });
  const fail = (id: Message['id'], code: number, message: string) =>
    reply({ id: id ?? null, error: { code, message } });
  const send = (m: Json | Json[]) => io.stdout(`${JSON.stringify(m)}\n`);

  /** The answer to one message, or nothing for a notification. */
  async function answer(msg: Message, inBatch = false): Promise<Json | undefined> {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return fail(null, -32600, 'Invalid request');
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (inBatch && msg.method === 'initialize') {
      return isRequest ? fail(msg.id, -32600, 'initialize cannot be part of a batch') : undefined;
    }
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
        batches = version < '2025-06-18';
        return reply({
          id: msg.id,
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: 'spend-brake', title: profile.title, version: VERSION },
            instructions: profile.instructions,
          },
        });
      }
      case 'ping':
        return reply({ id: msg.id, result: {} });
      case 'tools/list':
        return reply({
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
        const raw = params.arguments ?? {};
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return reply({
            id: msg.id,
            result: text('Invalid arguments: expected an object.', true),
          });
        }
        const args = pick(raw as Json, tool.inputSchema);
        if (typeof args === 'string') {
          return reply({ id: msg.id, result: text(`Invalid arguments: ${args}.`, true) });
        }
        let res: ToolResult;
        try {
          res = await tool.run(io, args, structured);
        } catch (err) {
          // Answer the request whatever went wrong, so the client is never left waiting.
          return fail(msg.id, -32603, `Internal error: ${(err as Error).message}`);
        }
        return reply({ id: msg.id, result: res });
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  async function handle(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return send(fail(null, -32700, 'Parse error'));
    }
    if (!Array.isArray(msg)) {
      const a = await answer(msg as Message);
      return a && send(a);
    }
    // A batch (protocol 2025-03-26): one array of answers, none when all were notifications.
    if (!batches) {
      return send(fail(null, -32600, 'Batches are not supported in this protocol version'));
    }
    if (msg.length === 0) return send(fail(null, -32600, 'Invalid request'));
    const answers = (await Promise.all(msg.map((m) => answer(m as Message, true)))).filter(
      (a): a is Json => a !== undefined,
    );
    return answers.length ? send(answers) : undefined;
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
