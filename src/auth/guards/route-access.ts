import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../config/app-config';
import { PUBLIC_ROUTE, type PublicRule, REQUIRED_SCOPES } from '../auth.decorators';
import type { TokenScope } from '../token-scope';

/** Reads the auth metadata of the route being executed. Shared by both guards. */
@Injectable()
export class RouteAccess {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  isPublic(context: ExecutionContext): boolean {
    const rule = this.reflector.getAllAndOverride<PublicRule | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule === undefined) return false;
    return rule === true || rule(this.config);
  }

  requiredScopes(context: ExecutionContext): readonly TokenScope[] {
    return (
      this.reflector.getAllAndOverride<TokenScope[] | undefined>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? []
    );
  }
}
