export class TtlCacheLite<V> {
  private readonly entries = new Map<string, { value: V; until: number }>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await load();
    if (this.entries.size > 10_000) this.entries.clear();
    this.entries.set(key, { value, until: Date.now() + this.ttlMs });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
