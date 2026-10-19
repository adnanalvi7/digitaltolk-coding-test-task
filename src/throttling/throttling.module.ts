import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { type ThrottlerModuleOptions, ThrottlerModule } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { sha256Hex } from '../common/crypto/hash';
import { stringProperty } from '../common/type-guards';
import type { AppConfig } from '../config/app-config';
import { AuthFailureLimiter } from './auth-failure-limiter';
import { CountCredentialFailuresInterceptor } from './count-credential-failures.interceptor';
import { PostAuthThrottlerGuard, PreAuthThrottlerGuard } from './phased-throttler.guard';
import { type RateLimitPolicyName, policyOf } from './rate-limit-policy';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { ThrottlerName } from './throttler-names';

/**
 * Budget per verified token. Runs after authentication, so `principal` is the
 * token that actually authenticated; public routes fall back to the client IP.
 */
export function principalOrIpTracker(request: FastifyRequest): string {
  return request.principal ? `token:${request.principal.tokenId}` : `ip:${request.ip}`;
}

/** Credential-stuffing defence: budget per (IP, email) pair. */
export function ipAndEmailTracker(request: FastifyRequest): string {
  const email = stringProperty(request.body, 'email')?.trim().toLowerCase() ?? '';
  return `ip:${request.ip}|email:${sha256Hex(email)}`;
}

/** Key = throttler + tracker, so the `api` budget is shared across all routes. */
const keyFor = (_context: unknown, tracker: string, throttlerName: string): string =>
  `${throttlerName}:${tracker}`;

export function buildThrottlerOptions(
  config: AppConfig['throttle'],
  reflector: Reflector,
  storage: RedisThrottlerStorage,
): ThrottlerModuleOptions {
  /** Each named throttler only counts requests on routes that selected its policy. */
  const skipUnless =
    (name: RateLimitPolicyName) =>
    (context: Parameters<typeof policyOf>[1]): boolean =>
      policyOf(reflector, context) !== name;

  return {
    storage,
    generateKey: keyFor,
    throttlers: [
      {
        name: ThrottlerName.Auth,
        ttl: config.windowMs,
        limit: config.authLimit,
        skipIf: skipUnless('auth'),
        getTracker: (req) => ipAndEmailTracker(req as FastifyRequest),
      },
      {
        name: ThrottlerName.Api,
        ttl: config.windowMs,
        limit: config.apiLimit,
        skipIf: skipUnless('api'),
        getTracker: (req) => principalOrIpTracker(req as FastifyRequest),
      },
      {
        name: ThrottlerName.Export,
        ttl: config.windowMs,
        limit: config.exportLimit,
        skipIf: skipUnless('export'),
        getTracker: (req) => principalOrIpTracker(req as FastifyRequest),
      },
    ],
  };
}

@Module({ providers: [RedisThrottlerStorage], exports: [RedisThrottlerStorage] })
class ThrottlerStorageModule {}

@Module({
  imports: [
    ThrottlerStorageModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [ConfigService, Reflector, RedisThrottlerStorage],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        reflector: Reflector,
        storage: RedisThrottlerStorage,
      ) => buildThrottlerOptions(config.get('throttle', { infer: true }), reflector, storage),
    }),
  ],
  providers: [
    PreAuthThrottlerGuard,
    PostAuthThrottlerGuard,
    AuthFailureLimiter,
    CountCredentialFailuresInterceptor,
  ],
  exports: [
    PreAuthThrottlerGuard,
    PostAuthThrottlerGuard,
    AuthFailureLimiter,
    CountCredentialFailuresInterceptor,
    ThrottlerModule,
  ],
})
export class ThrottlingModule {}
