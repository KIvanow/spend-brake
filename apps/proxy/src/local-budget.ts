import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scope } from '@spend-brake/budget';

/** A fail-open request to record in Valkey once it is reachable again. */
export interface FailOpenEntry {
  orgId: string;
  scopes: Scope[];
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

/**
 * Fail-open spend kept on disk from a shutdown that could not reach Valkey to the next start.
 * Several proxies may share the directory (a scaled service on one volume): each writes its own
 * file, and a starting proxy claims a file by renaming it, so only one of them replays it. A file
 * stays until its entries are recorded or saved again: replaying twice overcounts, losing it
 * undercounts.
 */
export class JournalDir {
  private readonly id = randomUUID();
  private claimed: string[] = [];

  constructor(private readonly dir: string) {}

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
    for (const name of names.filter((n) => JOURNAL_FILE.test(n))) {
      const claim = join(this.dir, `${name}.replaying-${this.id}`);
      try {
        renameSync(join(this.dir, name), claim);
      } catch {
        continue; // another proxy claimed it first
      }
      try {
        entries.push(...parseJournal(readFileSync(claim, 'utf8')));
        this.claimed.push(claim);
      } catch (err) {
        renameSync(claim, join(this.dir, `${name}.bad`));
        onBad(name, err as Error);
      }
    }
    return entries;
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
