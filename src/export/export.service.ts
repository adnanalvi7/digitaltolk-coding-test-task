import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { VersionStore } from '../catalog-events/version-store';
import { SingleFlight } from '../common/async/single-flight';
import type { AppConfig } from '../config/app-config';
import { LocaleNotFoundError } from '../common/errors/errors';
import { LocaleDirectory } from '../locales/locale-directory';
import type { TagFilter } from '../translations/translation.model';
import { ExportCache } from './export-cache';
import { etagMatches, exportCacheKey, weakEtag } from './export-keys';
import { ExportRepository } from './export.repository';
import type { ExportFormat } from './formatters/export-formatter';
import { ExportFormatterRegistry } from './formatters/export-formatter.registry';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/**
 * Measured on the 3.2 MB `en` export: level 4 = 25 ms / 596 kB, level 6 =
 * 63 ms / 564 kB. Level 4 takes ~40 ms off every cold build for 5.7% more
 * bytes, which matters more under the 500 ms cold budget.
 */
const GZIP_LEVEL = 4;
const LOCK_POLL_INTERVAL_MS = 25;

export interface ExportRequest {
  readonly localeCode: string;
  readonly format: ExportFormat;
  readonly tags: TagFilter | undefined;
  readonly ifNoneMatch: string | undefined;
  readonly acceptsGzip: boolean;
}

export type ExportResult =
  | { readonly kind: 'not-modified'; readonly etag: string }
  | {
      readonly kind: 'document';
      /** Undefined in degraded mode (version store unreachable): never cacheable. */
      readonly etag: string | undefined;
      readonly body: Buffer;
      readonly encoding: 'gzip' | 'identity';
      readonly contentType: string;
    };

/**
 * Serves locale exports that are fast (cached, pre-compressed, 304s without
 * touching Postgres) and always fresh (the cache key embeds the catalog
 * version, which every committed write bumps).
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly builds = new SingleFlight<string, Buffer>();
  private degraded = false;
  private readonly settings: AppConfig['export'];

  constructor(
    private readonly versions: VersionStore,
    private readonly locales: LocaleDirectory,
    private readonly repository: ExportRepository,
    private readonly cache: ExportCache,
    private readonly formatters: ExportFormatterRegistry,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.settings = config.get('export', { infer: true });
  }

  async export(request: ExportRequest): Promise<ExportResult> {
    const version = await this.currentVersion();
    const locale = await this.locales.findActive(request.localeCode, version);
    if (!locale) throw new LocaleNotFoundError(request.localeCode);
    const contentType = this.formatters.get(request.format).contentType;

    if (version === undefined) {
      const gzipped = await this.build(locale.id, request.format, request.tags);
      return this.document(undefined, gzipped, request.acceptsGzip, contentType);
    }

    const cacheKey = exportCacheKey(locale.code, request.format, request.tags, version);
    const etag = weakEtag(cacheKey);
    if (etagMatches(request.ifNoneMatch, etag)) return { kind: 'not-modified', etag };

    const gzipped = await this.getOrBuild(cacheKey, () =>
      this.build(locale.id, request.format, request.tags),
    );
    return this.document(etag, gzipped, request.acceptsGzip, contentType);
  }

  /** Pre-builds the untagged exports of every active locale (used by the warmer). */
  async warm(formats: readonly ExportFormat[]): Promise<void> {
    const version = await this.versions.current();
    for (const locale of await this.locales.listActive(version)) {
      for (const format of formats) {
        const key = exportCacheKey(locale.code, format, undefined, version);
        await this.getOrBuild(key, () => this.build(locale.id, format, undefined));
      }
    }
  }

  private async currentVersion(): Promise<number | undefined> {
    try {
      const version = await this.versions.current();
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Version store recovered; export caching resumed');
      }
      return version;
    } catch (error: unknown) {
      // Degraded mode: correctness over speed. Build straight from Postgres.
      // Logged on the transition only, not once per request.
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn({ err: error }, 'Version store unavailable; serving uncached exports');
      }
      return undefined;
    }
  }

  private async document(
    etag: string | undefined,
    gzipped: Buffer,
    clientAcceptsGzip: boolean,
    contentType: string,
  ): Promise<ExportResult> {
    return clientAcceptsGzip
      ? { kind: 'document', etag, body: gzipped, encoding: 'gzip', contentType }
      : { kind: 'document', etag, body: await gunzip(gzipped), encoding: 'identity', contentType };
  }

  /** In-process coalescing: concurrent misses for one key share a single build. */
  private getOrBuild(cacheKey: string, build: () => Promise<Buffer>): Promise<Buffer> {
    return this.builds.run(cacheKey, () => this.loadOrBuild(cacheKey, build));
  }

  /** Cross-instance stampede protection: one builder per key via SET NX PX. */
  private async loadOrBuild(cacheKey: string, build: () => Promise<Buffer>): Promise<Buffer> {
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const owner = await this.cache.acquireBuildLock(cacheKey, this.settings.buildLockMs);
    if (owner === null) {
      const builtElsewhere = await this.waitForBuild(cacheKey);
      if (builtElsewhere) return builtElsewhere;
    }
    try {
      const gzipped = await build();
      await this.cache.set(cacheKey, gzipped, this.settings.cacheTtlSeconds);
      return gzipped;
    } finally {
      if (owner !== null) await this.cache.releaseBuildLock(cacheKey, owner);
    }
  }

  /**
   * Waits briefly for another instance's build. Capped well below the lock TTL
   * (EXPORT_LOCK_WAIT_MS) so a dead lock holder costs one duplicate build, not
   * a request blocked for the full lock lifetime.
   */
  private async waitForBuild(cacheKey: string): Promise<Buffer | null> {
    const deadline = Date.now() + this.settings.lockWaitMs;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS);
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }
    return null;
  }

  private async build(
    localeId: number,
    format: ExportFormat,
    tags: TagFilter | undefined,
  ): Promise<Buffer> {
    const entries = await this.repository.fetchEntries(localeId, tags);
    const json = await this.formatters.get(format).render(entries);
    return gzip(Buffer.from(json, 'utf8'), { level: GZIP_LEVEL });
  }
}
