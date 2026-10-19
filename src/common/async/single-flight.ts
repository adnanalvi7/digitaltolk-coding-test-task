/**
 * Deduplicates concurrent work per key: while a task for `key` is running,
 * every caller for that key receives the same promise. Once it settles, the
 * next call starts a fresh task. Used for cache rebuilds and reloads.
 */
export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = task().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Number of keys currently being computed (observability, tests). */
  get size(): number {
    return this.inFlight.size;
  }
}
