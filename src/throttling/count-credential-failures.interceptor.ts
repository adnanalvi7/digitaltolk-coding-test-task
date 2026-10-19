import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { InvalidCredentialsError } from '../common/errors/errors';
import { AuthFailureLimiter } from './auth-failure-limiter';

/**
 * Wraps credential exchange: refuses blocked IPs up front and counts every
 * wrong password, so spraying many emails from one IP is capped (the
 * per-(IP, email) throttler only caps attempts against a single account).
 */
@Injectable()
export class CountCredentialFailuresInterceptor implements NestInterceptor {
  constructor(private readonly failures: AuthFailureLimiter) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { ip } = context.switchToHttp().getRequest<FastifyRequest>();
    return from(this.failures.assertAllowed(ip)).pipe(
      switchMap(() => next.handle()),
      catchError((error: unknown) =>
        error instanceof InvalidCredentialsError
          ? from(this.failures.recordFailure(ip)).pipe(switchMap(() => throwError(() => error)))
          : throwError(() => error),
      ),
    );
  }
}
