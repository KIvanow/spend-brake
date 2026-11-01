import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scope, ScopeShare } from '@spend-brake/budget';

/** A fail-open request to record in Valkey once it is reachable again. */
export interface FailOpenEntry {
  orgId: string;
  scopes: Scope[];
  /** SKU scopes charged their own part (multi-SKU requests). */
  scopeShares: ScopeShare[];
  amount: bigint;
  timeZone: string;
  at: Date;
  units: { sku: string; units: bigint }[];
  event: Record<string, string>;
}

/**
 * In-memory daily budget per key, used only when Valkey is unreachable and the key is
 * `failOpen`. It is per process, so N proxy instances can each spend the allowance.
 */
export class LocalBudget {
  private readonly spent = new Map<string, bigint>();
  /** Spend made while Valkey was down, waiting to be recorded there. */
  readonly journal: FailOpenEntry[] = [];

  tryReserve(keyId: string, day: string, amount: bigint, allowance: bigint): boolean {
    const k = `${keyId}|${day}`;
    const used = this.spent.get(k) ?? 0n;
    if (used + amount > allowance) return false;
    this.spent.set(k, used + amount);
    return true;
  }

  used(keyId: string, day: string): bigint {
    return this.spent.get(`${keyId}|${day}`) ?? 0n;
  }

  /** Replace a reserved amount with the actual cost. */
  settle(keyId: string, day: string, reserved: bigint, actual: bigint): void {
    const k = `${keyId}|${day}`;
    this.spent.set(k, (this.spent.get(k) ?? 0n) - reserved + actual);
  }
}

/** The journal as JSON, for keeping it on disk across a restart (amounts as strings). */
export function serializeJournal(entries: readonly FailOpenEntry[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      ...e,
      scopeShares: e.scopeShares.map((s) => ({ scope: s.scope, amount: s.amount.toString() })),
      amount: e.amount.toString(),
      at: e.at.toISOString(),
      units: e.units.map((u) => ({ sku: u.sku, units: u.units.toString() })),
    })),
  );
}

export function parseJournal(text: string): FailOpenEntry[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('fail-open journal is not a list');
  return raw.map((e: Record<string, unknown>) => ({
    orgId: String(e.orgId),
    scopes: e.scopes as Scope[],
    scopeShares: ((e.scopeShares ?? []) as { scope: Scope; amount: string }[]).map((s) => ({
      scope: s.scope,
      amount: BigInt(s.amount),
    })),
    amount: BigInt(e.amount as string),
    timeZone: String(e.timeZone),
    at: new Date(e.at as string),
    units: (e.units as { sku: string; units: string }[]).map((u) => ({
      sku: u.sku,
      units: BigInt(u.units),
    })),
    event: e.event as Record<string, string>,
  }));
}

const JOURNAL_FILE = /^fail-open-[\w-]+\.json$/;
/** A file a proxy claimed for replay: the journal's name plus the claiming proxy's id. */
const CLAIMED_FILE = /^(fail-open-[\w-]+\.json)\.replaying-[\w-]+$/;

/**
 * How long a claimed file may go untouched before a starting proxy takes it over: the
 * containers' stop grace period. A live holder refreshes its claims on every replay tick, so an
 * older claim belongs to a proxy that was killed before it recorded the file.
 */
export const STALE_CLAIM_MS = 35_000;

/**
 * Fail-open spend kept on disk from a shutdown that could not reach Valkey to the next start.
 * Several proxies may share the directory (a scaled service on one volume): each writes its own
 * file, and a starting proxy claims a file by renaming it, so only one of them replays it. A file
 * stays until its entries are recorded or saved again: replaying twice overcounts, losing it
 * undercounts. A claim left by a proxy killed mid-replay is taken over once it is stale.
 */
export class JournalDir {
  private readonly id = randomUUID();
  private claimed: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly staleClaimMs = STALE_CLAIM_MS,
  ) {}

  /** Claim and read every file earlier shutdowns left. Unreadable ones are set aside. */
  load(onBad: (file: string, err: Error) => void): FailOpenEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: FailOpenEntry[] = [];
    for (const name of names) {
      const base = JOURNAL_FILE.test(name) ? name : this.staleClaim(name);
      if (base === null) continue;
      // The rename is the claim, so of two proxies starting together only one wins a file. It
      // also sets the file's ctime, which is what keeps a claim fresh.
      const claim = join(this.dir, `${base}.replaying-${this.id}`);
      try {
        renameSync(join(this.dir, name), claim);
      } catch {
        continue; // another proxy claimed it first
      }
      try {
        entries.push(...parseJournal(readFileSync(claim, 'utf8')));
        this.claimed.push(claim);
      } catch (err) {
        renameSync(claim, join(this.dir, `${base}.bad`));
        onBad(name, err as Error);
      }
    }
    return entries;
  }

  /** The journal name of a claimed file untouched for the grace period, else null. */
  private staleClaim(name: string): string | null {
    const m = CLAIMED_FILE.exec(name);
    if (!m) return null;
    try {
      const { ctimeMs } = statSync(join(this.dir, name));
      return Date.now() - ctimeMs >= this.staleClaimMs ? m[1]! : null;
    } catch {
      return null; // claimed or removed meanwhile
    }
  }

  /** Touch this proxy's claims, so no starting proxy takes them over while it lives. */
  async refresh(): Promise<void> {
    const now = new Date();
    await Promise.all(this.claimed.map((f) => utimes(f, now, now).catch(() => undefined)));
  }

  /** Whether claimed files are waiting to be recorded. */
  get holding(): boolean {
    return this.claimed.length > 0;
  }

  /** The claimed files' entries are recorded: drop the files. */
  async release(): Promise<void> {
    await Promise.all(this.claimed.map((f) => rm(f, { force: true })));
    this.claimed = [];
  }

  /** Write what is left for the next start (claimed entries included); returns the file. */
  async save(entries: readonly FailOpenEntry[]): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `fail-open-${this.id}.json`);
    await writeFile(`${file}.tmp`, serializeJournal(entries));
    await rename(`${file}.tmp`, file);
    await this.release();
    return file;
  }
}
