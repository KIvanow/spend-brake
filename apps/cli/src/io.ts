import type { SpawnOptions } from 'node:child_process';

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface Io {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  fetch: typeof fetch;
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => Child;
}

export interface Child {
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Documented exit codes: agents branch on these. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** Budget exhausted, spending killed or route unpriced: stop and ask the user. */
  budget: 3,
  /** Loop detected: the key is paused. Stop and ask the user. */
  loop: 4,
  /** The virtual key is missing, unknown, revoked or expired. */
  auth: 5,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.error,
  ) {
    super(message);
  }
}

export function config(io: Io) {
  const proxyUrl = (io.env.BRAKE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const apiUrl = (io.env.BRAKE_API_URL ?? 'http://localhost:8081').replace(/\/$/, '');
  return {
    proxyUrl,
    apiUrl,
    key: io.env.BRAKE_KEY,
    session: io.env.BRAKE_SESSION,
    adminToken: io.env.BRAKE_ADMIN_TOKEN,
  };
}

/** Exact decimal dollars to micros ("5", "0.25"); no floating point. */
export function usdToMicros(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim().replace(/^\$/, ''));
  if (!m) throw new CliError(`invalid dollar amount: ${value}`, EXIT.usage);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function microsToUsd(micros: bigint | number | string, decimals = 4): string {
  const m = BigInt(micros);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, decimals);
  return `${neg ? '-' : ''}$${whole}${decimals > 0 ? `.${frac}` : ''}`;
}

/** "90", "30s", "15m", "12h", "2d" to seconds. */
export function durationSec(value: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (!m) throw new CliError(`invalid duration: ${value}`, EXIT.usage);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * mult;
}
