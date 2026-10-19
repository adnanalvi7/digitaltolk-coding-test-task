import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.module';
import { CatalogChangeLog } from './catalog-change-log';

/**
 * Redis key of the cached catalog version. Namespaced by layout so values
 * written by an older versioning scheme can never be mistaken for change-log ids.
 */
export const CATALOG_VERSION_KEY = 'catalog:version';

/**
 * Fast read path for the catalog version (one Redis round trip per export).
 * The value is a cache of the Postgres change log, never the source of truth.
 */
export abstract class VersionStore {
  abstract current(): Promise<number>;
  /** Raises the cached version to `version` (never lowers it). */
  abstract publish(version: number): Promise<void>;
  /** Raw cached value without any fallback (null when absent). */
  abstract peek(): Promise<number | null>;
  /**
   * Replaces the cached value only if it still equals `expected` (CAS), so a
   * repair can never overwrite a concurrent legitimate publish.
   */
  abstract replaceIf(expected: number, next: number): Promise<boolean>;
}

/** Monotonic set: concurrent publishers can arrive out of order. */
const PUBLISH_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then redis.call('SET', KEYS[1], ARGV[1]) end
return 1
`;

const COMPARE_AND_SET_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

@Injectable()
export class RedisVersionStore extends VersionStore {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly changeLog: CatalogChangeLog,
  ) {
    super();
  }

  /**
   * If Redis lost the key (restart, flush, eviction), the version is restored
   * from Postgres — so it never moves backwards and collides with an old
   * cached document or ETag.
   */
  async current(): Promise<number> {
    const cached = await this.peek();
    if (cached !== null) return cached;
    const latest = await this.changeLog.latest();
    await this.publish(latest);
    return latest;
  }

  async publish(version: number): Promise<void> {
    await this.redis.eval(PUBLISH_SCRIPT, 1, CATALOG_VERSION_KEY, version);
  }

  async peek(): Promise<number | null> {
    const raw = await this.redis.get(CATALOG_VERSION_KEY);
    return raw === null ? null : Number(raw);
  }

  async replaceIf(expected: number, next: number): Promise<boolean> {
    const replaced = await this.redis.eval(
      COMPARE_AND_SET_SCRIPT,
      1,
      CATALOG_VERSION_KEY,
      String(expected),
      String(next),
    );
    return replaced === 1;
  }
}
