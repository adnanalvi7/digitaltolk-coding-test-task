export interface BoundedLruOptions<V> {
  /** Upper bound on the summed weight of all entries. */
  readonly maxWeight: number;
  /** Weight of one entry; defaults to 1 (i.e. maxWeight = max entry count). */
  readonly weigh?: (value: V) => number;
  /** Optional time-to-live per entry. */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

interface Entry<V> {
  readonly value: V;
  readonly weight: number;
  readonly expiresAt: number;
}

/**
 * Least-recently-used map bounded by total weight (bytes, count...) with an
 * optional TTL. Relies on Map insertion order: a hit is re-inserted at the
 * end, eviction removes from the front. All operations are O(1) amortised.
 */
export class BoundedLru<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private totalWeight = 0;
  private readonly weigh: (value: V) => number;
  private readonly now: () => number;

  constructor(private readonly options: BoundedLruOptions<V>) {
    this.weigh = options.weigh ?? (() => 1);
    this.now = options.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores the value unless it alone exceeds the budget; evicts LRU entries as needed. */
  set(key: K, value: V): void {
    const weight = this.weigh(value);
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    if (weight > this.options.maxWeight) return;
    const ttl = this.options.ttlMs ?? Number.POSITIVE_INFINITY;
    this.entries.set(key, { value, weight, expiresAt: this.now() + ttl });
    this.totalWeight += weight;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.totalWeight <= this.options.maxWeight) break;
      this.remove(oldestKey, oldest);
    }
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  get weight(): number {
    return this.totalWeight;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(key: K, entry: Entry<V>): void {
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
