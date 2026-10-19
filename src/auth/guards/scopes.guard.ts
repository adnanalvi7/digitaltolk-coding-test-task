import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { InsufficientScopeError } from '../../common/errors/errors';
import { principalFrom } from '../auth.decorators';
import { RouteAccess } from './route-access';

/** Enforces `@RequireScopes(...)`. Runs after {@link BearerTokenGuard}. */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly access: RouteAccess) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.access.isPublic(context)) return true;
    const required = this.access.requiredScopes(context);
    if (required.length === 0) return true;
    const { scopes } = principalFrom(context);
    const missing = required.filter((scope) => !scopes.has(scope));
    if (missing.length > 0) throw new InsufficientScopeError(missing);
    return true;
  }
}
