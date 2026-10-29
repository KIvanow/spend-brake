/**
 * In-memory daily budget per key, used only when Valkey is unreachable and the key is
 * `failOpen`. It is per process, so N proxy instances can each spend the allowance.
 */
export class LocalBudget {
  private readonly spent = new Map<string, bigint>();

  tryReserve(keyId: string, day: string, amount: bigint, allowance: bigint): boolean {
    const k = `${keyId}|${day}`;
    const used = this.spent.get(k) ?? 0n;
    if (used + amount > allowance) return false;
    this.spent.set(k, used + amount);
    return true;
  }

  /** Replace a reserved amount with the actual cost. */
  settle(keyId: string, day: string, reserved: bigint, actual: bigint): void {
    const k = `${keyId}|${day}`;
    this.spent.set(k, (this.spent.get(k) ?? 0n) - reserved + actual);
  }
}
