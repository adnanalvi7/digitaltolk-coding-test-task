import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { VersionStore } from './version-store';

/** Port used after a catalog write commits. */
export abstract class CatalogChangeNotifier {
  abstract notifyChanged(version: number): Promise<void>;
}

export type CatalogChangeListener = (version: number) => Promise<void>;

/** Port used by side effects that react to a committed change (CDN purge, warming). */
export abstract class CatalogChangeFeed {
  abstract subscribe(listener: CatalogChangeListener): void;
}

const PUBLISH_ATTEMPTS = 3;
const PUBLISH_BACKOFF_MS = 25;

/**
 * Post-commit hook: publishes the committed version to the Redis read cache
 * (awaited, so the HTTP response is only sent once exports see it), then runs
 * subscribers in the background.
 *
 * If publishing still fails after retries, nothing is lost: the version is in
 * Postgres, and the VersionReconciler republishes it within seconds.
 */
@Injectable()
export class PublishingCatalogNotifier
  implements CatalogChangeNotifier, CatalogChangeFeed, OnApplicationShutdown
{
  private readonly logger = new Logger(PublishingCatalogNotifier.name);
  private readonly listeners: CatalogChangeListener[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly versions: VersionStore) {}

  subscribe(listener: CatalogChangeListener): void {
    this.listeners.push(listener);
  }

  async notifyChanged(version: number): Promise<void> {
    await this.publishWithRetry(version);
    for (const listener of this.listeners) this.runInBackground(listener, version);
  }

  /** Resolves when all background listener work has settled (shutdown, tests). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  private async publishWithRetry(version: number): Promise<void> {
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
      try {
        await this.versions.publish(version);
        return;
      } catch (error: unknown) {
        if (attempt === PUBLISH_ATTEMPTS) {
          this.logger.error(
            { err: error, version },
            'Catalog version publish failed; the reconciler will republish it',
          );
          return;
        }
        await sleep(PUBLISH_BACKOFF_MS * attempt);
      }
    }
  }

  private runInBackground(listener: CatalogChangeListener, version: number): void {
    const task = listener(version)
      .catch((error: unknown) => {
        this.logger.error({ err: error, version }, 'Catalog change listener failed');
      })
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }
}
