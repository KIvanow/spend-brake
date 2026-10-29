interface Entry<V> {
  value: V;
  freshUntil: number;
  staleUntil: number;
}

/**
 * Small LRU with a freshness TTL. When the loader fails (Valkey down), a stale value inside the
 * stale window is served instead, so fail-open keys keep working through an outage.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly staleMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `staleOn` decides which load errors may fall back to a stale value (an outage), as opposed to
   * errors that mean the value is gone.
   */
  async get(
    key: string,
    load: () => Promise<V>,
    staleOn: (err: unknown) => boolean = () => true,
  ): Promise<{ value: V; stale: boolean }> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.freshUntil > t) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return { value: hit.value, stale: false };
    }
    try {
      const value = await load();
      this.set(key, value);
      return { value, stale: false };
    } catch (err) {
      if (hit && hit.staleUntil > t && staleOn(err)) return { value: hit.value, stale: true };
      throw err;
    }
  }

  /** A fresh value without loading; undefined when missing or expired. */
  peek(key: string): V | undefined {
    const hit = this.entries.get(key);
    return hit && hit.freshUntil > this.now() ? hit.value : undefined;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  set(key: string, value: V): void {
    const t = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, freshUntil: t + this.ttlMs, staleUntil: t + this.staleMs });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}
