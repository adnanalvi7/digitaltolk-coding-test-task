import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { MS_PER_SECOND } from '../common/units';
import { InjectRedis } from '../redis/redis.module';

/** Mirrors @nestjs/throttler's ThrottlerStorageRecord (not exported from the package root). */
export interface ThrottleRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Fixed-window counter with an optional block period, executed atomically in
 * Redis so limits hold across every app instance.
 *
 * KEYS[1] hit counter, KEYS[2] block marker
 * ARGV[1] window ms, ARGV[2] limit, ARGV[3] block duration ms
 * Returns { hits, windowPttl, blocked (0|1), blockPttl }
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local windowTtl = redis.call('PTTL', KEYS[1])
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then return { hits, windowTtl, 1, blockTtl } end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, windowTtl, 1, tonumber(ARGV[3]) }
end
return { hits, windowTtl, 0, 0 }
`;

type ScriptReply = [number, number, number, number];

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const [hits, windowTtl, blocked, blockTtl] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${keyBase(throttlerName, key)}:hits`,
      `${keyBase(throttlerName, key)}:block`,
      ttl,
      limit,
      blockDuration,
    )) as ScriptReply;
    return {
      totalHits: hits,
      timeToExpire: toSeconds(windowTtl),
      isBlocked: blocked === 1,
      timeToBlockExpire: toSeconds(blockTtl),
    };
  }

  /** Seconds left on an active block for `key`, or 0. Read-only: consumes no budget. */
  async blockedFor(key: string, throttlerName: string): Promise<number> {
    return toSeconds(await this.redis.pttl(`${keyBase(throttlerName, key)}:block`));
  }
}

const keyBase = (throttlerName: string, key: string): string => `throttle:${throttlerName}:${key}`;

/** Redis PTTL (ms, or negative when absent) → whole seconds, never negative. */
const toSeconds = (pttl: number): number => Math.max(0, Math.ceil(pttl / MS_PER_SECOND));
