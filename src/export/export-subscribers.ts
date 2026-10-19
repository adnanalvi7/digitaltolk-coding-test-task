import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogChangeFeed } from '../catalog-events/catalog-change-notifier';
import { latestOnly } from '../common/async/latest-only';
import type { AppConfig } from '../config/app-config';
import { CdnPurger } from './cdn/cdn-purger';
import { ExportService } from './export.service';
import { ExportFormat } from './formatters/export-formatter';

/**
 * Purges the CDN after committed catalog changes. A burst of writes collapses
 * into one purge for the latest version (CDN purge APIs are rate-limited).
 */
@Injectable()
export class CdnPurgeSubscriber implements OnModuleInit {
  private readonly debounceMs: number;

  constructor(
    private readonly feed: CatalogChangeFeed,
    private readonly purger: CdnPurger,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.debounceMs = config.get('export', { infer: true }).sideEffectDebounceMs;
  }

  onModuleInit(): void {
    this.feed.subscribe(latestOnly((version) => this.purger.purge(version), this.debounceMs));
  }
}

/**
 * Optional (EXPORT_WARM_ON_CHANGE): after changes settle, pre-builds the
 * untagged exports of every active locale so the first request is a warm hit.
 * Debounced to the latest version, so a write burst triggers one warm-up,
 * not one per write.
 */
@Injectable()
export class ExportWarmer implements OnModuleInit {
  private readonly settings: AppConfig['export'];

  constructor(
    private readonly feed: CatalogChangeFeed,
    private readonly exports: ExportService,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.settings = config.get('export', { infer: true });
  }

  onModuleInit(): void {
    if (!this.settings.warmOnChange) return;
    this.feed.subscribe(
      latestOnly(
        () => this.exports.warm([ExportFormat.Flat, ExportFormat.Nested]),
        this.settings.sideEffectDebounceMs,
      ),
    );
  }
}
