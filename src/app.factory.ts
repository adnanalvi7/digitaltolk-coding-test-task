import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { useContainer } from 'class-validator';
import type { IncomingMessage } from 'node:http';
import { Logger } from 'nestjs-pino';
import { type AppModuleOptions, AppModule } from './app.module';
import { REQUEST_ID_HEADER, resolveRequestId } from './common/http/request-id';
import type { AppConfig } from './config/app-config';
import { setupSwagger } from './openapi';
import { LocaleValueMapConstraint } from './translations/validators/locale-value-map.validator';

export const API_PREFIX = 'api/v1';

/** Validator constraints that need Nest DI (everything else class-validator builds itself). */
const DI_BACKED_CONSTRAINTS: ReadonlySet<unknown> = new Set([LocaleValueMapConstraint]);

/**
 * class-validator also asks the container for its own internals; Nest treats
 * an unknown-provider lookup as fatal, so only our constraints are resolved
 * through Nest and every other class falls back to class-validator.
 */
function registerValidatorContainer(app: NestFastifyApplication): void {
  useContainer(
    {
      get: <T>(someClass: new (...args: never[]) => T): T | undefined =>
        DI_BACKED_CONSTRAINTS.has(someClass) ? app.get(someClass) : undefined,
    },
    { fallback: true },
  );
}

const COMPRESS_THRESHOLD_BYTES = 1_024;
const CORS_MAX_AGE_SECONDS = 600;

/**
 * Builds the fully configured (but not yet listening) application. Shared by
 * main.ts, the e2e suite and the OpenAPI export script so they are identical.
 */
export async function createApp(
  config: AppConfig,
  options: AppModuleOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: config.app.bodyLimitBytes,
    trustProxy: config.app.trustProxy,
    requestIdHeader: false,
    genReqId: (req: IncomingMessage) => resolveRequestId(req),
    // Fastify's secure JSON parser rejects __proto__/constructor poisoning (400).
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, options),
    adapter,
    // bodyParser: false keeps only Fastify's native JSON parser; Nest would
    // otherwise also accept application/x-www-form-urlencoded.
    { bufferLogs: true, bodyParser: false },
  );
  app.useLogger(app.get(Logger));

  const fastify = app.getHttpAdapter().getInstance();
  // JSON only: with the text/plain parser removed, any other body type is a 415.
  fastify.removeContentTypeParser(['text/plain']);
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  // Skips responses that already carry Content-Encoding (the pre-gzipped export).
  await app.register(compress, { encodings: ['br', 'gzip'], threshold: COMPRESS_THRESHOLD_BYTES });
  app.enableCors({
    origin: config.app.corsOrigins.length > 0 ? [...config.app.corsOrigins] : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'X-Request-Id'],
    exposedHeaders: ['ETag', 'Location', 'Retry-After', 'X-Request-Id'],
    maxAge: CORS_MAX_AGE_SECONDS,
  });

  app.setGlobalPrefix(API_PREFIX);
  registerValidatorContainer(app);
  if (config.app.swaggerEnabled) setupSwagger(app);
  app.enableShutdownHooks();
  return app;
}
