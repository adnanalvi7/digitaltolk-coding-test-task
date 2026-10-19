import { Global, Module } from '@nestjs/common';
import { CatalogChangeLog, KyselyCatalogChangeLog } from './catalog-change-log';
import {
  CatalogChangeFeed,
  CatalogChangeNotifier,
  PublishingCatalogNotifier,
} from './catalog-change-notifier';
import { CatalogTransaction, VersionedCatalogTransaction } from './catalog-transaction';
import { VersionReconciler } from './version-reconciler';
import { RedisVersionStore, VersionStore } from './version-store';

@Global()
@Module({
  providers: [
    { provide: CatalogChangeLog, useClass: KyselyCatalogChangeLog },
    { provide: VersionStore, useClass: RedisVersionStore },
    PublishingCatalogNotifier,
    { provide: CatalogChangeNotifier, useExisting: PublishingCatalogNotifier },
    { provide: CatalogChangeFeed, useExisting: PublishingCatalogNotifier },
    { provide: CatalogTransaction, useClass: VersionedCatalogTransaction },
    VersionReconciler,
  ],
  exports: [VersionStore, CatalogChangeFeed, CatalogTransaction, CatalogChangeLog],
})
export class CatalogEventsModule {}
