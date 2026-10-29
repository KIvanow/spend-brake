import { EventEmitter } from 'node:events';
import type { Child, Io } from '../src/io.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface Fake {
  io: Io;
  out: string[];
  err: string[];
  calls: Call[];
  spawned: { cmd: string; args: string[]; env: Record<string, string> }[];
}

type Responder = (c: Call) => { status: number; body: unknown; headers?: Record<string, string> };

export function fake(env: Record<string, string>, respond: Responder, childExit = 0): Fake {
  const f: Fake = { out: [], err: [], calls: [], spawned: [], io: undefined as never };
  f.io = {
    env,
    stdout: (s) => void f.out.push(s),
    stderr: (s) => void f.err.push(s),
    fetch: ((input: string | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: init?.body as string | undefined,
      };
      f.calls.push(call);
      const r = respond(call);
      return Promise.resolve(
        new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
          status: r.status,
          headers: r.headers ?? {},
        }),
      );
    }) as typeof fetch,
    spawn: (cmd, args, opts) => {
      f.spawned.push({ cmd, args, env: opts.env as Record<string, string> });
      const child = new EventEmitter() as EventEmitter & Child;
      child.kill = () => true;
      setTimeout(() => child.emit('exit', childExit, null), 5);
      return child;
    },
  };
  return f;
}
