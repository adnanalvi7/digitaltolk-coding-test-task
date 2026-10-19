import { type CustomDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export type RateLimitPolicyName = 'auth' | 'api' | 'export' | 'none';

export const RATE_LIMIT_POLICY = 'rate-limit:policy';
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicyName = 'api';

/**
 * Selects which named throttler applies to a route. Unannotated routes use the
 * `api` policy (per-token budget shared across the whole API).
 */
export const RateLimitPolicy = (policy: RateLimitPolicyName): CustomDecorator =>
  SetMetadata(RATE_LIMIT_POLICY, policy);

export function policyOf(reflector: Reflector, context: ExecutionContext): RateLimitPolicyName {
  return (
    reflector.getAllAndOverride<RateLimitPolicyName | undefined>(RATE_LIMIT_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? DEFAULT_RATE_LIMIT_POLICY
  );
}
