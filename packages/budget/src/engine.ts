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
  loop?: LoopCheck;
  /** Hard caps to create on first use when a scope has none, e.g. a session budget. */
  capTemplates?: CapTemplate[];
}

export interface LoopPolicy {
  /** Max identical requests per window before the circuit trips. */
  identical: number;
  windowSec: number;
  /** Max requests per minute on one session (or key, without a session). */
  perMinute: number;
  cooldownSec: number;
}

export interface LoopCheck extends LoopPolicy {
  keyId: string;
  /** Normalized request hash from the catalog adapter. */
  hash: string;
  /** Session whose request rate is limited (`perMinute`); without one only `identical` applies. */
  rateScope?: Scope;
}

export interface CapTemplate {
  scope: Scope;
  kind: WindowKind;
  hard: bigint;
}

export interface ReservationHandle {
  /** (held, spent) key pairs the reservation touched. */
  pairs: string[];
}

export interface SettleOptions {
  /**
   * Whether the provider billed the request. Units are counted only then, but always then, even
   * when the price was zero (inside a trusted free allowance), so the counter keeps advancing.
   */
  billed: boolean;
  /** Billed units to count for volume bands when actual > 0. */
  units?: readonly { sku: string; units: bigint }[];
  timeZone: string;
  now?: Date;
  /** Usage event fields appended to the org's stream in the same call. */
  event?: Record<string, string>;
  eventMaxLen?: number;
}

/**
 * Backstop only: the worker trims each stream up to what the ledger consumed. This cap bounds
 * memory if no worker runs at all.
 */
export const EVENT_STREAM_MAX_LEN = 10_000_000;

/**
 * Session scopes are short-lived and client-named; their counters expire after two days instead
 * of the window's 40/400 days so abandoned sessions do not pile up.
 */
export const SESSION_WINDOW_TTL_SEC = 2 * 24 * 3600;

const windowTtl = (label: string, ttl: number) =>
  label.startsWith('sess:') ? Math.min(ttl, SESSION_WINDOW_TTL_SEC) : ttl;

export interface RecordSpendRequest {
  orgId: string;
  amount: bigint;
  scopes: Scope[];
  timeZone: string;
  /** When the spend happened; picks the day and month windows. */
  at: Date;
  units?: readonly { sku: string; units: bigint }[];
  event?: Record<string, string>;
}

export interface PumpingPolicy {
  perNumberPerHour: number;
  perPrefixPerHour: number;
  cooldownSec: number;
}

/** Messaging defaults: a handful of messages per number, a few dozen per prefix, per hour. */
export const DEFAULT_PUMPING_POLICY: PumpingPolicy = {
  perNumberPerHour: 5,
  perPrefixPerHour: 50,
  cooldownSec: 3600,
};

export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  identical: 20,
  windowSec: 60,
  perMinute: 300,
  cooldownSec: 600,
};

export type ReserveResult =
  | {
      outcome: 'ok';
      expiresAt: Date;
      crossings: Crossing[];
      /** Smallest hard cap headroom left after this reservation; null when nothing is capped. */
      remaining: bigint | null;
      /** Pass back to `settle` to commit without reading the reservation record. */
      handle: ReservationHandle;
    }
  | { outcome: 'killed'; target: string }
  | { outcome: 'loop_detected'; retryAfterSec: number; tripped: boolean }
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

    const templates = new Map(
      (req.capTemplates ?? []).map((t) => [
        `${scopeLabel(t.scope)}|${t.kind}`,
        assertMicros(t.hard, 'cap template'),
      ]),
    );
    const loop = req.loop;
    const keyList = [
      k.kill(),
      k.resexp(),
      k.res(reqId),
      // Unused placeholders under the same hash tag when there is no loop check.
      loop ? k.circuit(loop.keyId) : k.circuit('_'),
      loop ? k.loop(loop.keyId, loop.hash) : k.loop('_', '_'),
      loop?.rateScope ? k.rate(scopeLabel(loop.rateScope)) : k.rate('_'),
    ];
    const pairArgs: (string | number)[] = [];
    const pairs: string[] = [];
    for (const label of labels) {
      for (const w of windows) {
        pairs.push(k.held(label, w.id), k.spent(label, w.id));
        keyList.push(
          k.held(label, w.id),
          k.spent(label, w.id),
          k.cap(label, w.kind),
          k.alerted(label, w.id),
        );
        pairArgs.push(
          label,
          w.id,
          windowTtl(label, w.ttlSec),
          templates.get(`${label}|${w.kind}`) ?? '',
        );
      }
    }
    const args = [
      amount,
      reqId,
      expiresAt.getTime(),
      loop ? 1 : 0,
      loop?.identical ?? 0,
      loop?.windowSec ?? 0,
      loop?.rateScope ? loop.perMinute : 0,
      loop?.cooldownSec ?? 0,
      kill.length,
    ];
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
          remaining: reply[2] === -1 ? null : toBig(reply[2]),
          handle: { pairs },
        };
      case 'KILLED':
        return { outcome: 'killed', target: reply[1] as string };
      case 'LOOP':
        return {
          outcome: 'loop_detected',
          retryAfterSec: Number(reply[1]),
          tripped: reply[2] === 1,
        };
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
    return this.settleRecord(orgId, reqId, assertMicros(actual, 'actual'));
  }

  /** The provider did not bill: release the reservation. */
  refund(orgId: string, reqId: string): Promise<CommitResult> {
    return this.settleRecord(orgId, reqId, '0');
  }

  /**
   * Commit a reservation made by this process, count billed units and append the usage event,
   * all in one round trip. Idempotent like `commit`.
   */
  async settle(
    orgId: string,
    reqId: string,
    actual: bigint,
    handle: ReservationHandle,
    opts: SettleOptions,
  ): Promise<CommitResult> {
    const k = orgKeys(orgId);
    const actualArg = assertMicros(actual, 'actual');
    const month = windowsFor(opts.now ?? new Date(), opts.timeZone)[1];
    const units = opts.billed ? [...(opts.units ?? [])].filter((u) => u.units > 0n) : [];
    const keyList = [
      k.resexp(),
      k.res(assertReqId(reqId)),
      k.events(),
      ...handle.pairs,
      ...units.map((u) => k.units(u.sku, month.id)),
    ];
    const args: (string | number)[] = [
      reqId,
      actualArg,
      handle.pairs.length / 2,
      units.length,
      month.ttlSec,
      ...units.map((u) => u.units.toString()),
      opts.eventMaxLen ?? EVENT_STREAM_MAX_LEN,
      ...Object.entries(opts.event ?? {}).flat(),
    ];
    const reply = (await runScript(this.client, scripts.settle, keyList, args)) as [
      string,
      string?,
    ];
    if (reply[0] === 'SETTLED') return { outcome: 'already_settled' };
    const reserved = BigInt(reply[1]!);
    return { outcome: 'committed', reserved, actual, underpriced: actual > reserved };
  }

  /** Add spend that was never reserved (fail-open requests replayed after an outage). */
  async recordSpend(r: RecordSpendRequest): Promise<void> {
    const k = orgKeys(r.orgId);
    const windows = windowsFor(r.at, r.timeZone);
    const labels = [...new Set(r.scopes.map(scopeLabel))];
    const pairs = labels.flatMap((l) =>
      windows.map((w) => ({ key: k.spent(l, w.id), ttl: windowTtl(l, w.ttlSec) })),
    );
    const units = [...(r.units ?? [])].filter((u) => u.units > 0n);
    const month = windows[1];
    await runScript(
      this.client,
      scripts.record,
      [k.events(), ...pairs.map((p) => p.key), ...units.map((u) => k.units(u.sku, month.id))],
      [
        assertMicros(r.amount, 'amount'),
        pairs.length,
        units.length,
        month.ttlSec,
        ...pairs.map((p) => p.ttl),
        ...units.map((u) => u.units.toString()),
        EVENT_STREAM_MAX_LEN,
        ...Object.entries(r.event ?? {}).flat(),
      ],
    );
  }

  /** Commit at the reserved worst case (upstream timeout, expired reservation). */
  commitWorstCase(orgId: string, reqId: string): Promise<CommitResult> {
    return this.settleRecord(orgId, reqId, '-1');
  }

  private async settleRecord(orgId: string, reqId: string, actual: string): Promise<CommitResult> {
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

  /**
   * Count a message send against the pumping limits (per destination number and per number
   * prefix, per hour); over either, the key's circuit opens for the cooldown.
   */
  async pumpCheck(
    orgId: string,
    keyId: string,
    dest: { numberHash: string; prefix: string },
    limits: PumpingPolicy,
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number; tripped: boolean }> {
    const k = orgKeys(orgId);
    const reply = (await runScript(
      this.client,
      scripts.pump,
      [k.circuit(keyId), k.pumpNumber(keyId, dest.numberHash), k.pumpPrefix(keyId, dest.prefix)],
      [limits.perNumberPerHour, limits.perPrefixPerHour, limits.cooldownSec],
    )) as [string, number?, number?];
    if (reply[0] === 'OK') return { ok: true };
    return { ok: false, retryAfterSec: Number(reply[1]), tripped: reply[2] === 1 };
  }

  /** Close a key's loop circuit early (the alert's "Reset circuit" action). */
  async resetCircuit(orgId: string, keyId: string): Promise<void> {
    await this.client.del(orgKeys(orgId).circuit(keyId));
  }

  /** Units of each SKU counted this month; selects volume bands and free allowances. */
  async monthlyUnits(
    orgId: string,
    skus: readonly string[],
    timeZone: string,
    now = new Date(),
  ): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    if (skus.length === 0) return result;
    const k = orgKeys(orgId);
    const month = windowsFor(now, timeZone)[1];
    const values = await this.client.mget(...skus.map((s) => k.units(s, month.id)));
    skus.forEach((s, i) => result.set(s, BigInt(values[i] ?? '0')));
    return result;
  }

  /** Count billed units after a request settles. */
  async addUnits(
    orgId: string,
    items: readonly { sku: string; units: bigint }[],
    timeZone: string,
    now = new Date(),
  ): Promise<void> {
    if (items.length === 0) return;
    const k = orgKeys(orgId);
    const month = windowsFor(now, timeZone)[1];
    const tx = this.client.multi();
    for (const item of items) {
      if (item.units <= 0n) continue;
      const key = k.units(item.sku, month.id);
      tx.incrby(key, item.units.toString());
      tx.expire(key, month.ttlSec, 'NX');
    }
    await tx.exec();
  }

  /**
   * Mark a provider billing session (such as an autocomplete session token) as started. Returns
   * true for the first request of the session, which carries the session's price.
   */
  async startBillingSession(
    orgId: string,
    provider: string,
    tokenHash: string,
    ttlSec: number,
  ): Promise<boolean> {
    const res = await this.client.set(
      orgKeys(orgId).billingSession(provider, tokenHash),
      '1',
      'EX',
      ttlSec,
      'NX',
    );
    return res === 'OK';
  }

  async isBillingSessionStarted(
    orgId: string,
    provider: string,
    tokenHash: string,
  ): Promise<boolean> {
    return (await this.client.exists(orgKeys(orgId).billingSession(provider, tokenHash))) === 1;
  }

  /** Append a usage event to the org's stream for the worker (ledger, alerts). */
  async emit(
    orgId: string,
    event: Record<string, string>,
    maxLen = EVENT_STREAM_MAX_LEN,
  ): Promise<string> {
    const id = await this.client.xadd(
      orgKeys(orgId).events(),
      'MAXLEN',
      '~',
      maxLen,
      '*',
      ...Object.entries(event).flat(),
    );
    return id ?? '';
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
