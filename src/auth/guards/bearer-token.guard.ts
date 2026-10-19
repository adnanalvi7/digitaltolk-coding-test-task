import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InvalidTokenError } from '../../common/errors/errors';
import { AuthFailureLimiter } from '../../throttling/auth-failure-limiter';
import { TokenService } from '../token.service';
import { RouteAccess } from './route-access';

const BEARER = /^Bearer[ ]+(\S+)$/i;

export function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header ? BEARER.exec(header)?.[1] : undefined;
}

/**
 * Global, secure-by-default authentication: every route requires a valid
 * bearer token unless it is explicitly marked `@Public()`.
 *
 * IPs with too many failed token checks are refused (429) before any database
 * lookup, so guessing or flooding with random tokens is bounded per client.
 */
@Injectable()
export class BearerTokenGuard implements CanActivate {
  constructor(
    private readonly access: RouteAccess,
    private readonly tokens: TokenService,
    private readonly failures: AuthFailureLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.access.isPublic(context)) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearerToken(request);
    if (token === undefined) throw new InvalidTokenError('missing');

    // A recently verified token needs no lookup, hence no failure-limit check.
    const cached = this.tokens.fromCache(token);
    if (cached) {
      request.principal = cached;
      return true;
    }

    await this.failures.assertAllowed(request.ip);
    try {
      request.principal = await this.tokens.authenticate(token);
    } catch (error: unknown) {
      if (error instanceof InvalidTokenError) await this.failures.recordFailure(request.ip);
      throw error;
    }
    return true;
  }
}
