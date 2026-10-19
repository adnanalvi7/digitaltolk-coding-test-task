import { Injectable } from '@nestjs/common';
import { type DbExecutor, TransactionRunner } from '../database/transaction-runner';
import { CatalogChangeLog } from './catalog-change-log';
import { CatalogChangeNotifier } from './catalog-change-notifier';

/**
 * Unit of work for every write that can change an export.
 *
 * 1. runs `work` in one database transaction,
 * 2. appends to the catalog change log inside that same transaction, so the
 *    version advances if and only if the write commits,
 * 3. after commit, publishes the new version and fires side effects.
 *
 * Services use this instead of hand-assembling transaction + version bump, so
 * no write path can forget (or misorder) the freshness bookkeeping.
 */
export abstract class CatalogTransaction {
  abstract run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T>;
}

@Injectable()
export class VersionedCatalogTransaction extends CatalogTransaction {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly changeLog: CatalogChangeLog,
    private readonly notifier: CatalogChangeNotifier,
  ) {
    super();
  }

  async run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T> {
    const { result, version } = await this.transactions.run(async (executor) => ({
      result: await work(executor),
      version: await this.changeLog.record(executor),
    }));
    await this.notifier.notifyChanged(version);
    return result;
  }
}
