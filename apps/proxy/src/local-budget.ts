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
