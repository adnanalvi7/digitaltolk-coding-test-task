import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import type { DbExecutor, TransactionRunner } from '../database/transaction-runner';
import type { CatalogChangeLog } from './catalog-change-log';
import { PublishingCatalogNotifier } from './catalog-change-notifier';
import { VersionedCatalogTransaction } from './catalog-transaction';
import { CHANGE_LOG_RETAINED_ROWS, VersionReconciler } from './version-reconciler';
import type { VersionStore } from './version-store';

const store = (): jest.Mocked<VersionStore> => ({
  current: jest.fn(),
  publish: jest.fn(),
  peek: jest.fn().mockResolvedValue(null),
  replaceIf: jest.fn(),
});
const changeLog = (): jest.Mocked<CatalogChangeLog> => ({
  record: jest.fn(),
  latest: jest.fn(),
  prune: jest.fn(),
});

describe('PublishingCatalogNotifier', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('publishes the committed version, then runs every subscriber with it', async () => {
    const versions = store();
    const notifier = new PublishingCatalogNotifier(versions);
    const seen: number[] = [];
    notifier.subscribe((v) => {
      seen.push(v);
      return Promise.resolve();
    });
    notifier.subscribe((v) => {
      seen.push(v * 10);
      return Promise.resolve();
    });

    await notifier.notifyChanged(7);
    await notifier.drain();

    expect(versions.publish).toHaveBeenCalledWith(7);
    expect(seen).toEqual([7, 70]);
  });

  it('awaits the publish but not the subscribers', async () => {
    const notifier = new PublishingCatalogNotifier(store());
    const slow = Promise.withResolvers<undefined>();
    let finished = false;
    notifier.subscribe(async () => {
      await slow.promise;
      finished = true;
    });

    await notifier.notifyChanged(1);
    expect(finished).toBe(false);
    slow.resolve(undefined);
    await notifier.onApplicationShutdown();
    expect(finished).toBe(true);
  });

  it('retries a failed publish', async () => {
    const versions = store();
    versions.publish.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(undefined);
    await new PublishingCatalogNotifier(versions).notifyChanged(2);
    expect(versions.publish).toHaveBeenCalledTimes(2);
  });

  it('logs and gives up after bounded retries without failing the committed write', async () => {
    const versions = store();
    versions.publish.mockRejectedValue(new Error('redis down'));
    const notifier = new PublishingCatalogNotifier(versions);
    await expect(notifier.notifyChanged(3)).resolves.toBeUndefined();
    expect(versions.publish).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('isolates failing subscribers', async () => {
    const notifier = new PublishingCatalogNotifier(store());
    const healthy = jest.fn().mockResolvedValue(undefined);
    notifier.subscribe(() => Promise.reject(new Error('cdn down')));
    notifier.subscribe(healthy);
    await notifier.notifyChanged(4);
    await notifier.drain();
    expect(healthy).toHaveBeenCalledWith(4);
  });
});

describe('VersionedCatalogTransaction', () => {
  const trx = { trx: true } as unknown as DbExecutor;
  const runner = {
    run: jest.fn((work: (executor: DbExecutor) => Promise<unknown>) => work(trx)),
  } as unknown as TransactionRunner;

  it('records the change inside the transaction and notifies after commit', async () => {
    const log = changeLog();
    log.record.mockResolvedValue(42);
    const notifier = { notifyChanged: jest.fn().mockResolvedValue(undefined) };
    const order: string[] = [];
    const result = await new VersionedCatalogTransaction(runner, log, notifier).run((executor) => {
      order.push(executor === trx ? 'work-in-trx' : 'work-outside');
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    expect(order).toEqual(['work-in-trx']);
    expect(log.record).toHaveBeenCalledWith(trx);
    expect(notifier.notifyChanged).toHaveBeenCalledWith(42);
  });

  it('never notifies when the work fails (the transaction rolls back)', async () => {
    const log = changeLog();
    const notifier = { notifyChanged: jest.fn() };
    await expect(
      new VersionedCatalogTransaction(runner, log, notifier).run(() =>
        Promise.reject(new Error('constraint')),
      ),
    ).rejects.toThrow('constraint');
    expect(log.record).not.toHaveBeenCalled();
    expect(notifier.notifyChanged).not.toHaveBeenCalled();
  });
});

describe('VersionReconciler', () => {
  const config = {
    get: () => ({ reconcileIntervalMs: 5 }),
  } as unknown as ConfigService<AppConfig, true>;

  afterEach(() => jest.restoreAllMocks());

  it('republishes the authoritative version and prunes the log', async () => {
    const log = changeLog();
    log.latest.mockResolvedValue(9);
    const versions = store();
    await new VersionReconciler(log, versions, config).reconcile();
    expect(versions.publish).toHaveBeenCalledWith(9);
    expect(log.prune).toHaveBeenCalledWith(CHANGE_LOG_RETAINED_ROWS);
  });

  it('repairs a cached version that is ahead of Postgres (restore / old layout) with CAS', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = changeLog();
    log.latest.mockResolvedValue(9);
    const versions = store();
    versions.peek.mockResolvedValue(1_792_000_000_000_000);
    versions.replaceIf.mockResolvedValue(true);
    await new VersionReconciler(log, versions, config).reconcile();
    expect(versions.replaceIf).toHaveBeenCalledWith(1_792_000_000_000_000, 9);
    expect(versions.publish).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('does not log a repair when a concurrent publish won the CAS', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = changeLog();
    log.latest.mockResolvedValue(9);
    const versions = store();
    versions.peek.mockResolvedValue(50);
    versions.replaceIf.mockResolvedValue(false);
    await new VersionReconciler(log, versions, config).reconcile();
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows failures so the next tick can retry', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = changeLog();
    log.latest.mockRejectedValue(new Error('db down'));
    await expect(new VersionReconciler(log, store(), config).reconcile()).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('runs on an interval and stops on shutdown', async () => {
    const log = changeLog();
    log.latest.mockResolvedValue(1);
    const versions = store();
    const reconciler = new VersionReconciler(log, versions, config);
    reconciler.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await reconciler.onApplicationShutdown();
    const calls = versions.publish.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(versions.publish.mock.calls.length).toBe(calls);
  });
});
