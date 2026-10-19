import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { RouteAccess } from './guards/route-access';
import { Argon2PasswordHasher, PasswordHasher } from './password-hasher';
import { KyselyTokenRepository, TokenRepository } from './repositories/token.repository';
import { KyselyUserRepository, UserRepository } from './repositories/user.repository';
import { ThrottlingModule } from '../throttling/throttling.module';
import { TokenService } from './token.service';

/**
 * The global guards (throttle → bearer → scopes) are registered together in
 * AppModule so their execution order is explicit; this module supplies them.
 */
@Module({
  imports: [ThrottlingModule],
  controllers: [AuthController],
  providers: [
    TokenService,
    RouteAccess,
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: UserRepository, useClass: KyselyUserRepository },
    { provide: TokenRepository, useClass: KyselyTokenRepository },
  ],
  exports: [TokenService, RouteAccess, PasswordHasher, UserRepository],
})
export class AuthModule {}
