import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import { CatalogChangeLog } from './catalog-change-log';
import { VersionStore } from './version-store';

/** Change-log rows kept after pruning (only max(id) is ever read). */
export const CHANGE_LOG_RETAINED_ROWS = 1_000;

/**
 * Periodically republishes the authoritative version (Postgres) to the Redis
 * read cache. This bounds export staleness after a failed post-commit publish
 * to one interval, instead of a cache TTL.
 */
@Injectable()
export class VersionReconciler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VersionReconciler.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly changeLog: CatalogChangeLog,
    private readonly versions: VersionStore,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.intervalMs = config.get('catalog', { infer: true }).reconcileIntervalMs;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.running ??= this.reconcile().finally(() => {
        this.running = undefined;
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /**
   * One reconciliation pass; never throws (the next pass retries).
   *
   * Redis is read *before* Postgres. Since a version is only published after
   * its row commits, a cached value above the authoritative one cannot come
   * from normal operation — only from corruption, a database restore or an
   * older key layout — and would freeze exports forever under monotonic
   * publishing. It is repaired with compare-and-set, so a legitimate publish
   * racing with this pass is never overwritten.
   */
  async reconcile(): Promise<void> {
    try {
      const cached = await this.versions.peek();
      const latest = await this.changeLog.latest();
      if (cached !== null && cached > latest) {
        if (await this.versions.replaceIf(cached, latest)) {
          this.logger.warn({ cached, latest }, 'Repaired a catalog version ahead of Postgres');
        }
      } else {
        await this.versions.publish(latest);
      }
      await this.changeLog.prune(CHANGE_LOG_RETAINED_ROWS);
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Catalog version reconciliation failed');
    }
  }
}
