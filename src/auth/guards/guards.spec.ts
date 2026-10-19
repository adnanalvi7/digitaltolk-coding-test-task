import { Controller, type ExecutionContext, Get } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/app-config';
import {
  InsufficientScopeError,
  InvalidTokenError,
  RateLimitedError,
} from '../../common/errors/errors';
import type { AuthFailureLimiter } from '../../throttling/auth-failure-limiter';
import { CurrentPrincipal, Public, RequireScopes, principalFrom } from '../auth.decorators';
import type { AuthPrincipal } from '../principal';
import type { TokenService } from '../token.service';
import { TokenScope } from '../token-scope';
import { BearerTokenGuard, extractBearerToken } from './bearer-token.guard';
import { RouteAccess } from './route-access';
import { ScopesGuard } from './scopes.guard';

@Controller()
class FixtureController {
  @Get() @Public() open(): string {
    return 'open';
  }
  @Get() @Public((config) => config.get('export', { infer: true }).public) conditional(): string {
    return 'conditional';
  }
  @Get() @RequireScopes(TokenScope.TranslationsWrite, TokenScope.LocalesWrite) admin(): string {
    return 'admin';
  }
  @Get() anyAuthenticated(): string {
    return 'any';
  }
  @Get() whoAmI(@CurrentPrincipal() principal: AuthPrincipal): AuthPrincipal {
    return principal;
  }
}

function context(handler: keyof FixtureController, request: Partial<FastifyRequest>) {
  return {
    getHandler: () => FixtureController.prototype[handler],
    getClass: () => FixtureController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function access(exportPublic = false): RouteAccess {
  const config = {
    get: () => ({ public: exportPublic }),
  } as unknown as ConfigService<AppConfig, true>;
  return new RouteAccess(new Reflector(), config);
}

const principal = (...scopes: TokenScope[]): AuthPrincipal => ({
  tokenId: '1',
  tokenHash: 'h1',
  userId: '1',
  scopes: new Set(scopes),
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer   abc', 'abc'],
    ['Basic abc', undefined],
    ['Bearer', undefined],
    ['Bearer a b', undefined],
  ])('parses %p', (header, expected) => {
    expect(extractBearerToken({ headers: { authorization: header } } as FastifyRequest)).toBe(
      expected,
    );
  });

  it('handles a missing header', () => {
    expect(extractBearerToken({ headers: {} } as FastifyRequest)).toBeUndefined();
  });
});

describe('BearerTokenGuard', () => {
  const tokens = {
    authenticate: jest.fn(),
    fromCache: jest.fn(),
  } as unknown as jest.Mocked<TokenService>;
  const failures = {
    assertAllowed: jest.fn(),
    recordFailure: jest.fn(),
  } as unknown as jest.Mocked<AuthFailureLimiter>;
  const guard = (exportPublic = false) =>
    new BearerTokenGuard(access(exportPublic), tokens, failures);
  const withToken = (): Partial<FastifyRequest> => ({
    ip: '10.0.0.9',
    headers: { authorization: 'Bearer tms_x' },
  });

  beforeEach(() => jest.resetAllMocks());

  it('lets public routes through without a token', async () => {
    await expect(guard().canActivate(context('open', { headers: {} }))).resolves.toBe(true);
    expect(tokens.authenticate).not.toHaveBeenCalled();
  });

  it('evaluates conditional public rules against config', async () => {
    await expect(guard(true).canActivate(context('conditional', { headers: {} }))).resolves.toBe(
      true,
    );
    await expect(guard(false).canActivate(context('conditional', { headers: {} }))).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('is secure by default: unannotated routes require a token', async () => {
    await expect(guard().canActivate(context('anyAuthenticated', { headers: {} }))).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('attaches the authenticated principal to the request', async () => {
    tokens.authenticate.mockResolvedValue(principal(TokenScope.TranslationsRead));
    const request = withToken();
    await guard().canActivate(context('anyAuthenticated', request));
    expect(tokens.authenticate).toHaveBeenCalledWith('tms_x');
    expect(request.principal?.scopes.has(TokenScope.TranslationsRead)).toBe(true);
    expect(failures.recordFailure).not.toHaveBeenCalled();
  });

  it('serves a recently verified token from cache without the limiter or a lookup', async () => {
    tokens.fromCache.mockReturnValue(principal(TokenScope.ExportRead));
    const request = withToken();
    await expect(guard().canActivate(context('anyAuthenticated', request))).resolves.toBe(true);
    expect(request.principal?.scopes.has(TokenScope.ExportRead)).toBe(true);
    expect(failures.assertAllowed).not.toHaveBeenCalled();
    expect(tokens.authenticate).not.toHaveBeenCalled();
  });

  it('counts a rejected token against the client IP', async () => {
    tokens.authenticate.mockRejectedValue(new InvalidTokenError('unknown'));
    await expect(guard().canActivate(context('anyAuthenticated', withToken()))).rejects.toThrow(
      InvalidTokenError,
    );
    expect(failures.recordFailure).toHaveBeenCalledWith('10.0.0.9');
  });

  it('refuses a blocked IP before any token lookup', async () => {
    failures.assertAllowed.mockRejectedValue(new RateLimitedError(42));
    await expect(guard().canActivate(context('anyAuthenticated', withToken()))).rejects.toThrow(
      RateLimitedError,
    );
    expect(tokens.authenticate).not.toHaveBeenCalled();
  });

  it('does not count infrastructure errors as authentication failures', async () => {
    tokens.authenticate.mockRejectedValue(new Error('db down'));
    await expect(guard().canActivate(context('anyAuthenticated', withToken()))).rejects.toThrow(
      'db down',
    );
    expect(failures.recordFailure).not.toHaveBeenCalled();
  });
});

describe('ScopesGuard', () => {
  const guard = new ScopesGuard(access());

  it('allows public routes and routes without scope requirements', () => {
    expect(guard.canActivate(context('open', {}))).toBe(true);
    expect(guard.canActivate(context('anyAuthenticated', { principal: principal() }))).toBe(true);
  });

  it('requires every listed scope', () => {
    expect(
      guard.canActivate(
        context('admin', {
          principal: principal(TokenScope.TranslationsWrite, TokenScope.LocalesWrite),
        }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(context('admin', { principal: principal(TokenScope.TranslationsWrite) })),
    ).toThrow(InsufficientScopeError);
  });

  it('fails closed if no principal is present on a protected route', () => {
    expect(() => guard.canActivate(context('admin', {}))).toThrow(InvalidTokenError);
  });
});

describe('principalFrom', () => {
  it('returns the request principal', () => {
    const p = principal();
    expect(principalFrom(context('whoAmI', { principal: p }))).toBe(p);
  });
});
