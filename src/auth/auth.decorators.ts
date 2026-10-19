import {
  type CustomDecorator,
  type ExecutionContext,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/app-config';
import { InvalidTokenError } from '../common/errors/errors';
import type { AuthPrincipal } from './principal';
import type { TokenScope } from './token-scope';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_SCOPES = 'auth:scopes';

/** Either always public, or public only when the predicate holds for the running config. */
export type PublicRule = true | ((config: ConfigService<AppConfig, true>) => boolean);

/**
 * Opts a route out of the global (secure-by-default) authentication. Pass a
 * predicate to make it conditional, e.g. the export when EXPORT_PUBLIC=true.
 */
export const Public = (rule: PublicRule = true): CustomDecorator => SetMetadata(PUBLIC_ROUTE, rule);

/** Requires every listed scope on the caller's token. */
export const RequireScopes = (...scopes: TokenScope[]): CustomDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

export function principalFrom(context: ExecutionContext): AuthPrincipal {
  const principal = context.switchToHttp().getRequest<FastifyRequest>().principal;
  if (!principal) throw new InvalidTokenError('no principal on an authenticated route');
  return principal;
}

/** Injects the authenticated {@link AuthPrincipal}. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal => principalFrom(context),
);
