import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Translation Management Service')
    .setDescription(
      [
        'API-first translation management: locales, tagged keys, search and a',
        'versioned, always-fresh JSON export for frontend i18n.',
        '',
        '- Successful responses use a `{ data, meta? }` envelope (except the raw export).',
        '- Errors are RFC 7807 `application/problem+json` and always include `requestId`.',
        '- bigint ids are serialised as strings.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'opaque',
      description: 'Token from POST /api/v1/auth/tokens (prefixed `tms_`).',
    })
    .build();
  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
}
