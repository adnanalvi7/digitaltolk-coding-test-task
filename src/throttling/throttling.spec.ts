import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { AppConfig } from '../config/app-config';
import { InvalidCredentialsError, RateLimitedError } from '../common/errors/errors';
import { AuthFailureLimiter } from './auth-failure-limiter';
import { CountCredentialFailuresInterceptor } from './count-credential-failures.interceptor';
import { RATE_LIMIT_POLICY, policyOf } from './rate-limit-policy';
import type { RedisThrottlerStorage } from './redis-throttler.storage';
import {
  buildThrottlerOptions,
  ipAndEmailTracker,
  principalOrIpTracker,
} from './throttling.module';

const THROTTLE: AppConfig['throttle'] = {
  windowMs: 60_000,
  authLimit: 5,
  apiLimit: 120,
  exportLimit: 600,
  authFailureLimit: 3,
};

const req = (overrides: Partial<FastifyRequest>): FastifyRequest =>
  ({ ip: '10.0.0.1', headers: {}, ...overrides }) as FastifyRequest;

describe('throttle trackers', () => {
  it('keys the API budget by the verified token id, never by a presented string', () => {
    const authenticated = req({
      headers: { authorization: 'Bearer tms_anything' },
      principal: { tokenId: '42', tokenHash: 'h', userId: '1', scopes: new Set() },
    });
    expect(principalOrIpTracker(authenticated)).toBe('token:42');
    // A bearer header without a verified principal (public route) is ignored.
    expect(principalOrIpTracker(req({ headers: { authorization: 'Bearer random' } }))).toBe(
      'ip:10.0.0.1',
    );
  });

  it('tracks credential attempts per IP + normalised email', () => {
    const a = ipAndEmailTracker(req({ body: { email: ' Admin@Example.com ' } }));
    const b = ipAndEmailTracker(req({ body: { email: 'admin@example.com' } }));
    expect(a).toBe(b);
    expect(a).not.toContain('admin@example.com');
    expect(ipAndEmailTracker(req({ body: 'not-json' }))).toMatch(/^ip:10\.0\.0\.1\|email:/);
    expect(ipAndEmailTracker(req({ body: { email: 42 } }))).toBe(ipAndEmailTracker(req({})));
  });
});

describe('rate-limit policy and throttler options', () => {
  class Annotated {
    route(): string {
      return 'x';
    }
  }
  Reflect.defineMetadata(RATE_LIMIT_POLICY, 'export', Annotated.prototype.route);
  const context = (handler: () => string) =>
    ({ getHandler: () => handler, getClass: () => Annotated }) as unknown as ExecutionContext;

  it('defaults to the api policy and honours annotations', () => {
    const reflector = new Reflector();
    expect(policyOf(reflector, context(Annotated.prototype.route))).toBe('export');
    expect(
      policyOf(
        reflector,
        context(() => 'plain'),
      ),
    ).toBe('api');
  });

  it('builds one named throttler per policy that skips the others', () => {
    const options = buildThrottlerOptions(THROTTLE, new Reflector(), {} as RedisThrottlerStorage);
    if (Array.isArray(options)) throw new Error('expected object options');
    const exportContext = context(Annotated.prototype.route);
    expect(options.throttlers.map((t) => [t.name, t.skipIf?.(exportContext)])).toEqual([
      ['auth', true],
      ['api', true],
      ['export', false],
    ]);
    expect(options.generateKey?.(exportContext, 'ip:1', 'api')).toBe('api:ip:1');
  });
});

describe('AuthFailureLimiter', () => {
  const storage = {
    blockedFor: jest.fn(),
    increment: jest.fn(),
  } as unknown as jest.Mocked<RedisThrottlerStorage>;
  const config = { get: () => THROTTLE } as unknown as ConfigService<AppConfig, true>;
  const limiter = new AuthFailureLimiter(storage, config);

  beforeEach(() => jest.resetAllMocks());

  it('allows an IP that is not blocked', async () => {
    storage.blockedFor.mockResolvedValue(0);
    await expect(limiter.assertAllowed('1.2.3.4')).resolves.toBeUndefined();
    expect(storage.blockedFor).toHaveBeenCalledWith('ip:1.2.3.4', 'auth-failure');
  });

  it('refuses a blocked IP with the remaining time', async () => {
    storage.blockedFor.mockResolvedValue(17);
    await expect(limiter.assertAllowed('1.2.3.4')).rejects.toMatchObject({
      retryAfterSeconds: 17,
    });
  });

  it('records failures against the configured window and limit', async () => {
    await limiter.recordFailure('1.2.3.4');
    expect(storage.increment).toHaveBeenCalledWith('ip:1.2.3.4', 60_000, 3, 60_000, 'auth-failure');
  });
});

describe('CountCredentialFailuresInterceptor', () => {
  const failures = {
    assertAllowed: jest.fn(),
    recordFailure: jest.fn(),
  } as unknown as jest.Mocked<AuthFailureLimiter>;
  const interceptor = new CountCredentialFailuresInterceptor(failures);
  const http = {
    switchToHttp: () => ({ getRequest: () => ({ ip: '9.9.9.9' }) }),
  } as unknown as ExecutionContext;
  const handler = (result: () => ReturnType<CallHandler['handle']>): CallHandler => ({
    handle: result,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    failures.assertAllowed.mockResolvedValue(undefined);
    failures.recordFailure.mockResolvedValue(undefined);
  });

  it('passes successful logins through without counting', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          http,
          handler(() => of('ok')),
        ),
      ),
    ).resolves.toBe('ok');
    expect(failures.recordFailure).not.toHaveBeenCalled();
  });

  it('counts wrong passwords and rethrows', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          http,
          handler(() => throwError(() => new InvalidCredentialsError())),
        ),
      ),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(failures.recordFailure).toHaveBeenCalledWith('9.9.9.9');
  });

  it('does not count other errors', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          http,
          handler(() => throwError(() => new Error('x'))),
        ),
      ),
    ).rejects.toThrow('x');
    expect(failures.recordFailure).not.toHaveBeenCalled();
  });

  it('refuses a blocked IP before the handler runs', async () => {
    failures.assertAllowed.mockRejectedValueOnce(new RateLimitedError(5));
    const handle = jest.fn(() => of('never'));
    await expect(lastValueFrom(interceptor.intercept(http, { handle }))).rejects.toThrow(
      RateLimitedError,
    );
    expect(handle).not.toHaveBeenCalled();
  });
});
