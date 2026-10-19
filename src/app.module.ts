import { type DynamicModule, HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import type { KyselyPlugin } from 'kysely';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { BearerTokenGuard } from './auth/guards/bearer-token.guard';
import { ScopesGuard } from './auth/guards/scopes.guard';
import { CatalogEventsModule } from './catalog-events/catalog-events.module';
import { CommonModule } from './common/common.module';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { validationExceptionFactory } from './common/validation/validation-exception.factory';
import type { AppConfig } from './config/app-config';
import { DatabaseModule } from './database/database.module';
import { ExportModule } from './export/export.module';
import { HealthModule } from './health/health.module';
import { LocalesModule } from './locales/locales.module';
import { buildLoggerOptions } from './logging/logger.options';
import { RedisModule } from './redis/redis.module';
import { TagsModule } from './tags/tags.module';
import { PostAuthThrottlerGuard, PreAuthThrottlerGuard } from './throttling/phased-throttler.guard';
import { ThrottlingModule } from './throttling/throttling.module';
import { TranslationsModule } from './translations/translations.module';

export interface AppModuleOptions {
  /** Extra Kysely plugins (the e2e suite injects a query counter). */
  readonly kyselyPlugins?: readonly KyselyPlugin[];
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    exceptionFactory: validationExceptionFactory,
    validationError: { target: false, value: false },
  });
}

/**
 * Composition root. Built from an already-validated {@link AppConfig} so
 * tests can boot the real application with different settings.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ ...config })],
        }),
        LoggerModule.forRoot(buildLoggerOptions(config.app)),
        CommonModule,
        DatabaseModule.forRoot({ db: config.db, plugins: options.kyselyPlugins ?? [] }),
        RedisModule.forRoot(config.redis),
        CatalogEventsModule,
        ThrottlingModule,
        AuthModule,
        LocalesModule,
        TagsModule,
        TranslationsModule,
        ExportModule,
        HealthModule,
      ],
      providers: [
        // Global guards run in this exact order:
        // login throttle → authenticate (failure-limited per IP) → authorise → per-token budget.
        { provide: APP_GUARD, useClass: PreAuthThrottlerGuard },
        { provide: APP_GUARD, useClass: BearerTokenGuard },
        { provide: APP_GUARD, useClass: ScopesGuard },
        { provide: APP_GUARD, useClass: PostAuthThrottlerGuard },
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: ProblemDetailsExceptionFilter },
      ],
    };
  }
}
