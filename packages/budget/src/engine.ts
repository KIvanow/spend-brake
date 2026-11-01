import {
  type KillTarget,
  type Scope,
  type WindowKind,
  keys as orgKeys,
  killLabel,
  scopeLabel,
} from './keys.js';
import type { Cluster, Redis } from 'ioredis';
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
  /**
   * Scopes that hold only their share of `amount` rather than all of it, e.g. a secondary SKU's
   * scope holding just that SKU's line items. Settling charges them the same share of the actual
   * cost. A scope listed here need not be in `scopes`.
   */
  scopeShares?: ScopeShare[];
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

export interface ScopeShare {
  scope: Scope;
  amount: bigint;
}

export interface CapTemplate {
  scope: Scope;
  kind: WindowKind;
  hard: bigint;
}

export interface ReservationHandle {
  /** (held, spent) key pairs the reservation touched. */
  pairs: string[];
  /** The reserved amount. */
  amount?: bigint;
  /** What each pair holds when it is a share (see `scopeShares`), else null. */
  shares?: (bigint | null)[];
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

/**
 * How long a recorded entry id is remembered. Replays of one entry happen within seconds (a retry
 * after a lost reply, an overlapping run) or after a restart; 40 days covers any outage.
 */
export const RECORDED_TTL_SEC = 40 * 24 * 3600;

export interface RecordSpendRequest {
  orgId: string;
  /** Makes the record idempotent: spend with an id already recorded is not added again. */
  id?: string;
  amount: bigint;
  scopes: Scope[];
  timeZone: string;
  /** When the spend happened; picks the day and month windows. */
  at: Date;
  units?: readonly { sku: string; units: bigint }[];
  event?: Record<string, string>;
  /** Scopes charged their own share instead of `amount` (see `ReserveRequest.scopeShares`). */
  scopeShares?: ScopeShare[];
}

export interface PendingSettlement {
  provider: string;
  credentialId: string;
  /** Scope labels and the original time: an adjustment lands in the same windows. */
  scopes: string[];
  at: string;
  timeZone: string;
  /** What was committed at send time (the worst case). */
  committedMicros: string;
  /** Provider reference, e.g. Twilio's account and message SIDs. */
  ref: Record<string, string>;
  keyId: string;
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

/**
 * Why a key's circuit is open: the loop breaker (repeated requests) or the SMS pumping guard.
 * Either way the whole key is paused, for every provider it can call.
 */
export type PauseReason = 'loop' | 'pumping';

/** The circuit's value tells who opened it: the pumping guard stores 'pump'. */
export const pauseReason = (circuit: unknown): PauseReason =>
  circuit === 'pump' ? 'pumping' : 'loop';

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
  | { outcome: 'loop_detected'; retryAfterSec: number; tripped: boolean; reason: PauseReason }
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

/**
 * A share's part of an actual cost: the share's fraction of the reserved amount, rounded up so a
 * capped scope never sees less than its part.
 */
export function shareOf(actual: bigint, reserved: bigint, share: bigint): bigint {
  if (share === reserved) return actual;
  if (reserved === 0n) return 0n;
  return (actual * share + reserved - 1n) / reserved;
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
    const shares = new Map<string, bigint>();
    for (const s of req.scopeShares ?? []) {
      assertMicros(s.amount, 'share');
      shares.set(scopeLabel(s.scope), s.amount);
    }
    const labels = [...new Set([...req.scopes.map(scopeLabel), ...shares.keys()])];
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
    const pairShares: (bigint | null)[] = [];
    for (const label of labels) {
      const share = shares.get(label) ?? null;
      for (const w of windows) {
        pairs.push(k.held(label, w.id), k.spent(label, w.id));
        pairShares.push(share);
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
          share === null ? '' : share.toString(),
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
          handle: { pairs, amount: req.amount, shares: pairShares },
        };
      case 'KILLED':
        return { outcome: 'killed', target: reply[1] as string };
      case 'LOOP':
        return {
          outcome: 'loop_detected',
          retryAfterSec: Number(reply[1]),
          tripped: reply[2] === 1,
          reason: pauseReason(reply[3]),
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
    const nPairs = handle.pairs.length / 2;
    const parts = Array.from({ length: nPairs }, (_, i) => {
      const share = handle.shares?.[i] ?? null;
      return share === null || handle.amount === undefined
        ? actualArg
        : shareOf(actual, handle.amount, share).toString();
    });
    const args: (string | number)[] = [
      reqId,
      actualArg,
      nPairs,
      units.length,
      month.ttlSec,
      ...units.map((u) => u.units.toString()),
      ...parts,
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
  /** Returns false when spend with the same id was already recorded (nothing changed). */
  async recordSpend(r: RecordSpendRequest): Promise<boolean> {
    assertMicros(r.amount, 'amount');
    return this.writeSpend(r, r.amount);
  }

  /**
   * Correct spend already committed, in the windows of the original request (`at`): a settled
   * provider price below (or above) the worst case committed at send time. `delta` is signed.
   */
  async adjustSpend(
    r: Omit<RecordSpendRequest, 'amount' | 'units'> & { delta: bigint },
  ): Promise<void> {
    const abs = r.delta < 0n ? -r.delta : r.delta;
    assertMicros(abs, 'delta');
    await this.writeSpend({ ...r, amount: 0n }, r.delta);
  }

  private async writeSpend(r: RecordSpendRequest, amount: bigint): Promise<boolean> {
    const k = orgKeys(r.orgId);
    const windows = windowsFor(r.at, r.timeZone);
    const shares = new Map((r.scopeShares ?? []).map((s) => [scopeLabel(s.scope), s.amount]));
    const labels = [...new Set([...r.scopes.map(scopeLabel), ...shares.keys()])];
    const pairs = labels.flatMap((l) =>
      windows.map((w) => ({
        key: k.spent(l, w.id),
        ttl: windowTtl(l, w.ttlSec),
        amount: shares.get(l) ?? amount,
      })),
    );
    const units = [...(r.units ?? [])].filter((u) => u.units > 0n);
    const month = windows[1];
    const reply = await runScript(
      this.client,
      scripts.record,
      [
        k.events(),
        ...pairs.map((p) => p.key),
        ...units.map((u) => k.units(u.sku, month.id)),
        ...(r.id === undefined ? [] : [k.recorded(r.id)]),
      ],
      [
        pairs.length,
        units.length,
        month.ttlSec,
        RECORDED_TTL_SEC,
        ...pairs.map((p) => p.amount.toString()),
        ...pairs.map((p) => p.ttl),
        ...units.map((u) => u.units.toString()),
        EVENT_STREAM_MAX_LEN,
        ...Object.entries(r.event ?? {}).flat(),
      ],
    );
    return reply === 'OK';
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
    const parts: string[] = [];
    const n = Number(record.n ?? 0);
    for (let i = 1; i <= n; i++) {
      keyList.push(record[`h${i}`]!, record[`s${i}`]!);
      const share = record[`a${i}`];
      parts.push(
        actual === '-1' || share === undefined || record.amount === undefined
          ? actual
          : shareOf(BigInt(actual), BigInt(record.amount), BigInt(share)).toString(),
      );
    }

    const reply = (await runScript(this.client, scripts.commit, keyList, [reqId, ...parts])) as [
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
  ): Promise<
    { ok: true } | { ok: false; retryAfterSec: number; tripped: boolean; reason: PauseReason }
  > {
    const k = orgKeys(orgId);
    const reply = (await runScript(
      this.client,
      scripts.pump,
      [k.circuit(keyId), k.pumpNumber(keyId, dest.numberHash), k.pumpPrefix(keyId, dest.prefix)],
      [limits.perNumberPerHour, limits.perPrefixPerHour, limits.cooldownSec],
    )) as [string, number?, number?, string?];
    if (reply[0] === 'OK') return { ok: true };
    return {
      ok: false,
      retryAfterSec: Number(reply[1]),
      tripped: reply[2] === 1,
      reason: pauseReason(reply[3]),
    };
  }

  /**
   * Remember a send whose real price the provider reports later. The worker picks it up from
   * `checkAt` on (see `duePending`) and settles it once with `takePending`.
   */
  async addPending(
    orgId: string,
    reqId: string,
    record: PendingSettlement,
    checkAt: Date,
  ): Promise<void> {
    const k = orgKeys(orgId);
    const tx = this.client.multi();
    tx.set(k.pending(assertReqId(reqId)), JSON.stringify(record), 'EX', 4 * 24 * 3600);
    tx.zadd(k.pendingQueue(), checkAt.getTime(), reqId);
    await tx.exec();
  }

  async duePending(
    orgId: string,
    now = new Date(),
    limit = 200,
  ): Promise<{ reqId: string; record: PendingSettlement }[]> {
    const k = orgKeys(orgId);
    const ids = await this.client.zrangebyscore(
      k.pendingQueue(),
      '-inf',
      now.getTime(),
      'LIMIT',
      0,
      limit,
    );
    const out: { reqId: string; record: PendingSettlement }[] = [];
    for (const reqId of ids) {
      const raw = await this.client.get(k.pending(reqId));
      let record: PendingSettlement | null = null;
      try {
        record = raw === null ? null : (JSON.parse(raw) as PendingSettlement);
      } catch {
        // Unreadable: drop it rather than block the queue (the worst case stays committed).
      }
      if (record === null) await this.client.del(k.pending(reqId));
      if (record === null) await this.client.zrem(k.pendingQueue(), reqId);
      else out.push({ reqId, record });
    }
    return out;
  }

  /** Check again later (the provider has not priced it yet). */
  async deferPending(orgId: string, reqId: string, checkAt: Date): Promise<void> {
    await this.client.zadd(orgKeys(orgId).pendingQueue(), checkAt.getTime(), reqId);
  }

  /** Claim a pending send for settlement; false when another worker already did. */
  async takePending(orgId: string, reqId: string): Promise<boolean> {
    const k = orgKeys(orgId);
    const res = await this.client
      .multi()
      .del(k.pending(reqId))
      .zrem(k.pendingQueue(), reqId)
      .exec();
    return Number(res?.[0]?.[1] ?? 0) === 1;
  }

  /**
   * Close a key's loop circuit early (Resume, the alert's "Reset circuit" action). Its
   * identical-request counters and the session's rate counter go too: left in place, the next
   * repeat of the request would trip the circuit again at once.
   *
   * The SMS pumping counters (`pumpNumber`, `pumpPrefix`) stay. They count sends per hour to a
   * number or number range, which an outside attacker drives, not a bug in the app; clearing them
   * would hand the attacker a fresh hour's allowance on every reset. As when the cooldown ends by
   * itself, sends to other numbers go through and the flagged ones trip it again.
   */
  async resetCircuit(orgId: string, keyId: string): Promise<void> {
    const k = orgKeys(orgId);
    const circuit = k.circuit(keyId);
    const tripped = await this.client.get(circuit);
    const counters = await this.scan(k.loops(keyId));
    // Only ever a rate key of this org (the script stores KEYS[6]); '1' for no session.
    if (tripped?.startsWith(k.rate(''))) counters.push(tripped);
    // Every key shares the org's hash tag, so one DEL is fine on a cluster too.
    for (let i = 0; i < counters.length; i += 500) {
      await this.client.del(...counters.slice(i, i + 500));
    }
    await this.client.del(circuit);
  }

  /**
   * Keys matching a pattern, with SCAN rather than KEYS (which blocks the server). A cluster
   * spreads keys over its primaries, so each is scanned.
   */
  private async scan(pattern: string): Promise<string[]> {
    const nodes = this.client.isCluster
      ? (this.client as Cluster).nodes('master')
      : [this.client as Redis];
    const found = new Set<string>();
    for (const node of nodes) {
      let cursor = '0';
      do {
        const [next, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = next;
        for (const key of batch) found.add(key);
      } while (cursor !== '0');
    }
    return [...found];
  }

  /**
   * Keys whose circuit is open, with the seconds until it closes by itself and what opened it
   * (the loop breaker or the SMS pumping guard).
   */
  async pausedKeys(
    orgId: string,
    keyIds: readonly string[],
  ): Promise<{ keyId: string; retryAfterSec: number; reason: PauseReason }[]> {
    if (keyIds.length === 0) return [];
    const k = orgKeys(orgId);
    const tx = this.client.multi();
    for (const id of keyIds) tx.pttl(k.circuit(id)).get(k.circuit(id));
    const res = (await tx.exec()) ?? [];
    const out: { keyId: string; retryAfterSec: number; reason: PauseReason }[] = [];
    keyIds.forEach((keyId, i) => {
      const ms = Number(res[2 * i]?.[1] ?? -2);
      // -2: no circuit; -1: open with no expiry (never set that way, but still paused).
      if (ms === -2) return;
      out.push({
        keyId,
        retryAfterSec: ms < 0 ? 0 : Math.ceil(ms / 1000),
        reason: pauseReason(res[2 * i + 1]?.[1]),
      });
    });
    return out;
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

  /** Billed requests seen in a provider billing session (0 when none or expired). */
  async billingSessionCalls(orgId: string, provider: string, tokenHash: string): Promise<number> {
    const v = await this.client.get(orgKeys(orgId).billingSession(provider, tokenHash));
    return v === null ? 0 : Number(v);
  }

  /**
   * Billed requests seen in a provider billing session with the seconds left before it expires
   * (both 0 when none or expired), so a caller can tell how old a fixed-TTL session is.
   */
  async billingSessionState(
    orgId: string,
    provider: string,
    tokenHash: string,
  ): Promise<{ calls: number; ttlLeftSec: number }> {
    const key = orgKeys(orgId).billingSession(provider, tokenHash);
    const res = await this.client.multi().get(key).ttl(key).exec();
    const v = res?.[0]?.[1] as string | null | undefined;
    const ttl = Number(res?.[1]?.[1] ?? 0);
    if (v === null || v === undefined) return { calls: 0, ttlLeftSec: 0 };
    return { calls: Number(v), ttlLeftSec: Math.max(0, ttl) };
  }

  /**
   * Count a billed request in a billing session. The TTL runs from the first request, or from
   * the latest one when `sliding`; `end` closes the session so the next request opens a new one.
   */
  async recordBillingSessionCall(
    orgId: string,
    provider: string,
    tokenHash: string,
    ttlSec: number,
    opts: { sliding?: boolean; end?: boolean } = {},
  ): Promise<void> {
    const key = orgKeys(orgId).billingSession(provider, tokenHash);
    if (opts.end) {
      await this.client.del(key);
      return;
    }
    const tx = this.client.multi().incr(key);
    if (opts.sliding) tx.expire(key, ttlSec);
    else tx.expire(key, ttlSec, 'NX');
    await tx.exec();
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
