import {
  type KillTarget,
  type Scope,
  type WindowKind,
  keys as orgKeys,
  killLabel,
  scopeLabel,
} from './keys.js';
import { type ValkeyClient, runScript, scripts } from './scripts.js';
import { windowResetsAt, windowsFor } from './windows.js';

/** Largest amount Lua can hold exactly (2^53 - 1 micros, about $9 billion). */
export const MAX_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

const REQ_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export type Mark = '50' | '80' | '100' | 'soft';

export interface Crossing {
  scope: string;
  window: string;
  mark: Mark;
}

export interface ReserveRequest {
  orgId: string;
  reqId: string;
  /** Worst-case cost in micros. */
  amount: bigint;
  scopes: Scope[];
  killTargets: KillTarget[];
  /** The org's time zone; day and month windows are cut in it. */
  timeZone: string;
  now?: Date;
}

export type ReserveResult =
  | { outcome: 'ok'; expiresAt: Date; crossings: Crossing[] }
  | { outcome: 'killed'; target: string }
  | {
      outcome: 'budget_exceeded';
      scope: string;
      window: string;
      cap: bigint;
      /** Committed plus held in that scope and window when the request was denied. */
      used: bigint;
      resetsAt: Date;
      /** First deny for this scope and window: the 100% mark fired with it. */
      firstDeny: boolean;
    };

export type CommitResult =
  | { outcome: 'committed'; reserved: bigint; actual: bigint; underpriced: boolean }
  | { outcome: 'already_settled' };

export interface CapValues {
  hard: bigint | null;
  soft: bigint | null;
}

export interface Cap extends CapValues {
  version: number;
}

export interface ScopeStatus {
  scope: string;
  window: string;
  spent: bigint;
  held: bigint;
  hard: bigint | null;
  soft: bigint | null;
  /** hard - spent - held, floored at 0; null when there is no hard cap. */
  remaining: bigint | null;
}

export interface BudgetEngineOptions {
  /** How long a reservation may stay unsettled before the sweeper commits it. */
  reservationTtlMs?: number;
}

export interface SweepResult {
  committed: number;
  alreadySettled: number;
}

function assertMicros(value: bigint, what: string): string {
  if (value < 0n || value > MAX_MICROS) throw new RangeError(`${what} out of range: ${value}`);
  return value.toString();
}

function assertReqId(reqId: string): string {
  if (!REQ_ID.test(reqId)) throw new Error(`invalid reqId: ${JSON.stringify(reqId)}`);
  return reqId;
}

function toBig(v: unknown): bigint {
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  throw new TypeError(`unexpected reply value: ${String(v)}`);
}

function optBig(v: string | null | undefined): bigint | null {
  return v === null || v === undefined ? null : BigInt(v);
}

export class BudgetEngine {
  private readonly reservationTtlMs: number;

  constructor(
    private readonly client: ValkeyClient,
    opts: BudgetEngineOptions = {},
  ) {
    this.reservationTtlMs = opts.reservationTtlMs ?? 120_000;
  }

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const now = req.now ?? new Date();
    const k = orgKeys(req.orgId);
    const amount = assertMicros(req.amount, 'amount');
    const reqId = assertReqId(req.reqId);
    const labels = [...new Set(req.scopes.map(scopeLabel))];
    const kill = [...new Set(req.killTargets.map(killLabel))];
    const windows = windowsFor(now, req.timeZone);
    const expiresAt = new Date(now.getTime() + this.reservationTtlMs);

    const keyList = [k.kill(), k.resexp(), k.res(reqId)];
    const pairArgs: (string | number)[] = [];
    for (const label of labels) {
      for (const w of windows) {
        keyList.push(
          k.held(label, w.id),
          k.spent(label, w.id),
          k.cap(label, w.kind),
          k.alerted(label, w.id),
        );
        pairArgs.push(label, w.id, w.ttlSec);
      }
    }
    const args = [amount, reqId, expiresAt.getTime(), kill.length];
    const reply = (await runScript(this.client, scripts.reserve, keyList, [
      ...args,
      ...kill,
      ...pairArgs,
    ])) as unknown[];

    switch (reply[0]) {
      case 'OK':
        return {
          outcome: 'ok',
          expiresAt,
          crossings: (reply[1] as string[][]).map(([scope, window, mark]) => ({
            scope: scope!,
            window: window!,
            mark: mark as Mark,
          })),
        };
      case 'KILLED':
        return { outcome: 'killed', target: reply[1] as string };
      case 'DENY': {
        const window = reply[2] as string;
        return {
          outcome: 'budget_exceeded',
          scope: reply[1] as string,
          window,
          cap: toBig(reply[3]),
          used: toBig(reply[4]),
          resetsAt: windowResetsAt(window.startsWith('d:') ? 'd' : 'm', now, req.timeZone),
          firstDeny: reply[5] === 1,
        };
      }
      case 'DUPLICATE':
        throw new Error(`reservation ${reqId} already exists`);
      default:
        throw new Error(`unexpected reserve reply: ${JSON.stringify(reply)}`);
    }
  }

  /** Replace a reservation with the actual cost. Idempotent. */
  commit(orgId: string, reqId: string, actual: bigint): Promise<CommitResult> {
    return this.settle(orgId, reqId, assertMicros(actual, 'actual'));
  }

  /** The provider did not bill: release the reservation. */
  refund(orgId: string, reqId: string): Promise<CommitResult> {
    return this.settle(orgId, reqId, '0');
  }

  /** Commit at the reserved worst case (upstream timeout, expired reservation). */
  commitWorstCase(orgId: string, reqId: string): Promise<CommitResult> {
    return this.settle(orgId, reqId, '-1');
  }

  private async settle(orgId: string, reqId: string, actual: string): Promise<CommitResult> {
    const k = orgKeys(orgId);
    const resKey = k.res(assertReqId(reqId));
    // The record never changes after reserve, so reading it outside the script is safe; the
    // script re-checks that it still exists before touching any counter.
    const record = await this.client.hgetall(resKey);
    const keyList = [k.resexp(), resKey];
    const n = Number(record.n ?? 0);
    for (let i = 1; i <= n; i++) keyList.push(record[`h${i}`]!, record[`s${i}`]!);

    const reply = (await runScript(this.client, scripts.commit, keyList, [reqId, actual])) as [
      string,
      string?,
    ];
    if (reply[0] === 'SETTLED') return { outcome: 'already_settled' };
    const reserved = BigInt(reply[1]!);
    const actualAmount = actual === '-1' ? reserved : BigInt(actual);
    return {
      outcome: 'committed',
      reserved,
      actual: actualAmount,
      underpriced: actualAmount > reserved,
    };
  }

  /** Commit every reservation past its expiry at its worst case. */
  async sweep(orgId: string, now = new Date(), limit = 500): Promise<SweepResult> {
    const k = orgKeys(orgId);
    const expired = await this.client.zrangebyscore(
      k.resexp(),
      '-inf',
      now.getTime(),
      'LIMIT',
      0,
      limit,
    );
    const result: SweepResult = { committed: 0, alreadySettled: 0 };
    for (const reqId of expired) {
      const r = await this.commitWorstCase(orgId, reqId);
      if (r.outcome === 'committed') result.committed++;
      else result.alreadySettled++;
    }
    return result;
  }

  async kill(orgId: string, target: KillTarget): Promise<void> {
    await this.client.sadd(orgKeys(orgId).kill(), killLabel(target));
  }

  async unkill(orgId: string, target: KillTarget): Promise<void> {
    await this.client.srem(orgKeys(orgId).kill(), killLabel(target));
  }

  async killed(orgId: string): Promise<string[]> {
    return (await this.client.smembers(orgKeys(orgId).kill())).sort();
  }

  /** Set hard and soft caps for one scope and window kind; null removes that limit. */
  async setCap(orgId: string, scope: Scope, kind: WindowKind, values: CapValues): Promise<number> {
    const key = orgKeys(orgId).cap(scopeLabel(scope), kind);
    const tx = this.client.multi();
    for (const field of ['hard', 'soft'] as const) {
      const v = values[field];
      if (v === null) tx.hdel(key, field);
      else tx.hset(key, field, assertMicros(v, field));
    }
    tx.hincrby(key, 'version', 1);
    const res = await tx.exec();
    const last = res?.at(-1);
    if (!last || last[0]) throw last?.[0] ?? new Error('setCap transaction aborted');
    return Number(last[1]);
  }

  async getCap(orgId: string, scope: Scope, kind: WindowKind): Promise<Cap | null> {
    const h = await this.client.hgetall(orgKeys(orgId).cap(scopeLabel(scope), kind));
    if (h.version === undefined) return null;
    return { hard: optBig(h.hard), soft: optBig(h.soft), version: Number(h.version) };
  }

  async deleteCap(orgId: string, scope: Scope, kind: WindowKind): Promise<void> {
    await this.client.del(orgKeys(orgId).cap(scopeLabel(scope), kind));
  }

  async status(
    orgId: string,
    scopes: Scope[],
    timeZone: string,
    now = new Date(),
  ): Promise<ScopeStatus[]> {
    const k = orgKeys(orgId);
    const windows = windowsFor(now, timeZone);
    const pairs = [...new Set(scopes.map(scopeLabel))].flatMap((scope) =>
      windows.map((w) => ({ scope, w })),
    );
    // MULTI so every pair is read at the same instant.
    const tx = this.client.multi();
    for (const { scope, w } of pairs) {
      tx.get(k.spent(scope, w.id));
      tx.get(k.held(scope, w.id));
      tx.hmget(k.cap(scope, w.kind), 'hard', 'soft');
    }
    const res = await tx.exec();
    if (!res) throw new Error('status transaction aborted');
    return pairs.map(({ scope, w }, i) => {
      const [spentR, heldR, capR] = res.slice(i * 3, i * 3 + 3).map(([err, v]) => {
        if (err) throw err;
        return v;
      });
      const spent = optBig(spentR as string | null) ?? 0n;
      const held = optBig(heldR as string | null) ?? 0n;
      const [hardR, softR] = capR as (string | null)[];
      const hard = optBig(hardR);
      const remaining = hard === null ? null : hard - spent - held > 0n ? hard - spent - held : 0n;
      return { scope, window: w.id, spent, held, hard, soft: optBig(softR), remaining };
    });
  }
}
