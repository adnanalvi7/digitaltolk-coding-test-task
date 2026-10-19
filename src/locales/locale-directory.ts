import { Injectable } from '@nestjs/common';
import { VersionStore } from '../catalog-events/version-store';
import { SingleFlight } from '../common/async/single-flight';
import { Clock } from '../common/clock';
import { type LocaleRecord, LocaleRepository } from './locale.repository';

/** Upper bound on how long a locale snapshot is trusted without a version check. */
export const LOCALE_CACHE_TTL_MS = 30_000;
/** Minimum snapshot age before a lookup miss may trigger a reload. */
export const MISS_RELOAD_INTERVAL_MS = 1_000;

interface Snapshot {
  readonly version: number;
  readonly loadedAt: number;
  readonly byCode: ReadonlyMap<string, LocaleRecord>;
}

/**
 * In-memory locale lookup for hot paths (export, write validation).
 *
 * Freshness: the snapshot is tagged with the catalog version read *before*
 * loading. Callers that already know the current version (the export) pass
 * it, and an older snapshot is reloaded, so locale (de)activation is visible
 * across instances immediately. Other callers rely on the TTL plus a forced
 * reload on a miss.
 */
@Injectable()
export class LocaleDirectory {
  private snapshot: Snapshot | undefined;
  private readonly loads = new SingleFlight<'snapshot', Snapshot>();

  constructor(
    private readonly locales: LocaleRepository,
    private readonly versions: VersionStore,
    private readonly clock: Clock,
  ) {}

  /** Drops the snapshot; the next lookup reloads. Called after local writes. */
  invalidate(): void {
    this.snapshot = undefined;
  }

  async findActive(code: string, minVersion?: number): Promise<LocaleRecord | undefined> {
    const snapshot = await this.current(minVersion);
    const hit = snapshot.byCode.get(code);
    if (hit?.isActive) return hit;
    const reloaded = (await this.reloadAfterMiss(snapshot)).byCode.get(code);
    return reloaded?.isActive ? reloaded : undefined;
  }

  async listActive(minVersion?: number): Promise<LocaleRecord[]> {
    return [...(await this.current(minVersion)).byCode.values()].filter((l) => l.isActive);
  }

  /**
   * Maps codes to active locale ids. Unknown/inactive codes are absent from
   * the result (after a miss-triggered reload: the locale may be brand new).
   */
  async resolveActive(codes: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const snapshot = await this.current();
    const result = this.partition(snapshot, codes);
    if (result.missing.length === 0) return result.ids;
    return this.partition(await this.reloadAfterMiss(snapshot), codes).ids;
  }

  /**
   * A miss may mean "created moments ago on another instance", so reload —
   * but at most once per interval, so a stream of requests for an unknown
   * code cannot turn into a stream of queries.
   */
  private reloadAfterMiss(snapshot: Snapshot): Promise<Snapshot> {
    const age = this.clock.now().getTime() - snapshot.loadedAt;
    return age >= MISS_RELOAD_INTERVAL_MS ? this.reload() : Promise.resolve(snapshot);
  }

  private partition(
    snapshot: Snapshot,
    codes: readonly string[],
  ): { ids: ReadonlyMap<string, number>; missing: string[] } {
    const ids = new Map<string, number>();
    const missing: string[] = [];
    for (const code of codes) {
      const locale = snapshot.byCode.get(code);
      if (locale?.isActive) ids.set(code, locale.id);
      else missing.push(code);
    }
    return { ids, missing };
  }

  private async current(minVersion?: number): Promise<Snapshot> {
    const snapshot = this.snapshot;
    const fresh =
      snapshot !== undefined &&
      this.clock.now().getTime() - snapshot.loadedAt < LOCALE_CACHE_TTL_MS &&
      (minVersion === undefined || snapshot.version >= minVersion);
    return fresh ? snapshot : this.reload();
  }

  /** Coalesces concurrent reloads into a single query. */
  private reload(): Promise<Snapshot> {
    return this.loads.run('snapshot', () => this.load());
  }

  private async load(): Promise<Snapshot> {
    const version = await this.versions.current();
    const rows = await this.locales.findAll();
    const snapshot: Snapshot = {
      version,
      loadedAt: this.clock.now().getTime(),
      byCode: new Map(rows.map((row) => [row.code, row])),
    };
    this.snapshot = snapshot;
    return snapshot;
  }
}
