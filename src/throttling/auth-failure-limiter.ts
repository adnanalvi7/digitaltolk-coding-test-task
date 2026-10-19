import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/app-config';
import { RateLimitedError } from '../common/errors/errors';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { ThrottlerName } from './throttler-names';

/**
 * Per-IP budget of *failed* authentications (unknown/expired/revoked tokens,
 * wrong passwords), shared across instances through Redis.
 *
 * Counting failures rather than all requests means a busy office behind one
 * NAT is never throttled for valid traffic, while random-token floods and
 * password spraying across many emails are cut off before they reach
 * Postgres or argon2.
 */
@Injectable()
export class AuthFailureLimiter {
  private readonly settings: AppConfig['throttle'];

  constructor(
    private readonly storage: RedisThrottlerStorage,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.settings = config.get('throttle', { infer: true });
  }

  /** Throws {@link RateLimitedError} while the IP is blocked. One Redis round trip. */
  async assertAllowed(ip: string): Promise<void> {
    const retryAfter = await this.storage.blockedFor(trackerOf(ip), ThrottlerName.AuthFailure);
    if (retryAfter > 0) throw new RateLimitedError(retryAfter);
  }

  /** Records one failure; crossing the limit blocks the IP for one window. */
  async recordFailure(ip: string): Promise<void> {
    await this.storage.increment(
      trackerOf(ip),
      this.settings.windowMs,
      this.settings.authFailureLimit,
      this.settings.windowMs,
      ThrottlerName.AuthFailure,
    );
  }
}

const trackerOf = (ip: string): string => `ip:${ip}`;
