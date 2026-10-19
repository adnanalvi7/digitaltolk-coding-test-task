import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import { LocalesModule } from '../locales/locales.module';
import { CdnPurger, HttpCdnPurger, NullCdnPurger } from './cdn/cdn-purger';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { ExportCache, MemoryLayeredExportCache, RedisExportCache } from './export-cache';
import { CdnPurgeSubscriber, ExportWarmer } from './export-subscribers';
import { ExportController } from './export.controller';
import { ExportRepository, KyselyExportRepository } from './export.repository';
import { ExportService } from './export.service';
import { EXPORT_FORMATTERS, type ExportFormatter } from './formatters/export-formatter';
import { ExportFormatterRegistry } from './formatters/export-formatter.registry';
import { FlatExportFormatter } from './formatters/flat-export.formatter';
import { NestedExportFormatter } from './formatters/nested-export.formatter';

export function createCdnPurger(cdn: AppConfig['cdn']): CdnPurger {
  return cdn.purgeUrl === undefined
    ? new NullCdnPurger()
    : new HttpCdnPurger({
        purgeUrl: cdn.purgeUrl,
        token: cdn.purgeToken,
        publicBaseUrl: cdn.publicBaseUrl,
        exportPath: '/api/v1/export/',
      });
}

@Module({
  imports: [LocalesModule],
  controllers: [ExportController],
  providers: [
    ExportService,
    ExportFormatterRegistry,
    FlatExportFormatter,
    NestedExportFormatter,
    // Composition root for format strategies: register new formats here.
    {
      provide: EXPORT_FORMATTERS,
      useFactory: (...formatters: ExportFormatter[]) => formatters,
      inject: [FlatExportFormatter, NestedExportFormatter],
    },
    { provide: ExportRepository, useClass: KyselyExportRepository },
    {
      provide: ExportCache,
      useFactory: (redis: Redis, config: ConfigService<AppConfig, true>) =>
        new MemoryLayeredExportCache(
          new RedisExportCache(redis),
          config.get('export', { infer: true }).memoryCacheBytes,
        ),
      inject: [REDIS, ConfigService],
    },
    {
      provide: CdnPurger,
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createCdnPurger(config.get('cdn', { infer: true })),
      inject: [ConfigService],
    },
    CdnPurgeSubscriber,
    ExportWarmer,
  ],
})
export class ExportModule {}
