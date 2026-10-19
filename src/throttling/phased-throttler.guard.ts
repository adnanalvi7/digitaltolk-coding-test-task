import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { ThrottlerName } from './throttler-names';

/**
 * A ThrottlerGuard that only evaluates the throttlers of its phase, so the
 * same configuration can run partly before and partly after authentication.
 *
 * It also always sets the standard `Retry-After` header: the stock guard
 * suffixes it with the throttler name (`Retry-After-api`), which HTTP clients
 * and CDNs do not understand.
 */
abstract class PhasedThrottlerGuard extends ThrottlerGuard {
  protected abstract readonly phase: readonly ThrottlerName[];

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((throttler) =>
      this.phase.some((name) => name === throttler.name),
    );
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    void reply.header('Retry-After', String(Math.max(1, detail.timeToBlockExpire)));
    await super.throwThrottlingException(context, detail);
  }
}

/** Runs before authentication: per-(IP, email) limit on token issuance. */
@Injectable()
export class PreAuthThrottlerGuard extends PhasedThrottlerGuard {
  protected readonly phase = [ThrottlerName.Auth] as const;
}

/**
 * Runs after authentication, so budgets are keyed by the *verified* token id:
 * presenting random bearer strings cannot mint fresh budgets.
 */
@Injectable()
export class PostAuthThrottlerGuard extends PhasedThrottlerGuard {
  protected readonly phase = [ThrottlerName.Api, ThrottlerName.Export] as const;
}
