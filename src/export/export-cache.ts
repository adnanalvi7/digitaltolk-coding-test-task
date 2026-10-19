import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { BoundedLru } from '../common/cache/bounded-lru';
import { InjectRedis } from '../redis/redis.module';

/** Stores fully serialised, gzip-compressed export documents. */
export abstract class ExportCache {
  abstract get(key: string): Promise<Buffer | null>;
  abstract set(key: string, gzipped: Buffer, ttlSeconds: number): Promise<void>;
  /** Cross-instance build lock. @returns an owner token, or null if someone else holds it. */
  abstract acquireBuildLock(key: string, ttlMs: number): Promise<string | null>;
  abstract releaseBuildLock(key: string, owner: string): Promise<void>;
}

/**
 * In-process LRU in front of another ExportCache (decorator). Warm hits are
 * served from memory instead of pulling a ~0.5 MB blob from Redis per request.
 * Needs no invalidation: keys embed the catalog version, so the content behind
 * a key never changes, and superseded versions simply age out of the LRU.
 */
export class MemoryLayeredExportCache extends ExportCache {
  private readonly local: BoundedLru<string, Buffer>;

  constructor(
    private readonly backing: ExportCache,
    maxBytes: number,
  ) {
    super();
    this.local = new BoundedLru({ maxWeight: maxBytes, weigh: (buffer) => buffer.length });
  }

  async get(key: string): Promise<Buffer | null> {
    const hit = this.local.get(key);
    if (hit) return hit;
    const remote = await this.backing.get(key);
    if (remote) this.local.set(key, remote);
    return remote;
  }

  async set(key: string, gzipped: Buffer, ttlSeconds: number): Promise<void> {
    await this.backing.set(key, gzipped, ttlSeconds);
    this.local.set(key, gzipped);
  }

  acquireBuildLock(key: string, ttlMs: number): Promise<string | null> {
    return this.backing.acquireBuildLock(key, ttlMs);
  }

  releaseBuildLock(key: string, owner: string): Promise<void> {
    return this.backing.releaseBuildLock(key, owner);
  }

  /** Bytes currently held in memory (observability and tests). */
  get size(): number {
    return this.local.weight;
  }
}

/** Deletes the lock only if we still own it (it may have expired and been re-acquired). */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

@Injectable()
export class RedisExportCache extends ExportCache {
  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
  }

  get(key: string): Promise<Buffer | null> {
    return this.redis.getBuffer(key);
  }

  async set(key: string, gzipped: Buffer, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, gzipped, 'EX', ttlSeconds);
  }

  async acquireBuildLock(key: string, ttlMs: number): Promise<string | null> {
    const owner = randomUUID();
    const result = await this.redis.set(`lock:${key}`, owner, 'PX', ttlMs, 'NX');
    return result === 'OK' ? owner : null;
  }

  async releaseBuildLock(key: string, owner: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, `lock:${key}`, owner);
  }
}
