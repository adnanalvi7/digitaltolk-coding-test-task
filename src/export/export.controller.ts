import { Controller, Get, Headers, HttpStatus, Inject, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public, RequireScopes } from '../auth/auth.decorators';
import { TokenScope } from '../auth/token-scope';
import type { AppConfig } from '../config/app-config';
import { ApiProblemResponses } from '../common/http/problem-responses';
import { LocaleCodePipe } from '../common/pipes/locale-code.pipe';
import { RateLimitPolicy } from '../throttling/rate-limit-policy';
import { TagMatchMode } from '../translations/translation.model';
import { ExportQueryDto } from './dto/export-query.dto';
import { acceptsGzip } from './export-keys';
import { ExportService } from './export.service';
import { ExportFormat } from './formatters/export-formatter';

export const isExportPublic = (config: ConfigService<AppConfig, true>): boolean =>
  config.get('export', { infer: true }).public;

/** Merges into an existing Vary (e.g. `Origin` from CORS) instead of replacing it. */
export function appendVary(reply: FastifyReply, fields: string): void {
  const existing = reply.getHeader('vary');
  const current = typeof existing === 'string' && existing.length > 0 ? [existing] : [];
  void reply.header('vary', [...current, fields].join(', '));
}

@ApiTags('export')
@Controller('export')
export class ExportController {
  private readonly cacheControl: string;
  private readonly vary: string;

  constructor(
    private readonly exports: ExportService,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    const settings = config.get('export', { infer: true });
    // Public: CDN-cacheable; browsers always revalidate (max-age=0) via ETag.
    // Private: every cache must revalidate, and shared caches must not store it.
    this.cacheControl = settings.public
      ? `public, max-age=0, s-maxage=${settings.sMaxAgeSeconds}, stale-while-revalidate=${settings.staleWhileRevalidateSeconds}, must-revalidate`
      : 'private, no-cache';
    this.vary = settings.public ? 'Accept-Encoding' : 'Accept-Encoding, Authorization';
  }

  @Get(':locale')
  @Public(isExportPublic)
  @RequireScopes(TokenScope.ExportRead)
  @RateLimitPolicy('export')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Export one locale as JSON for frontend i18n (always fresh)',
    description:
      'Requires `export:read` unless EXPORT_PUBLIC=true. Served pre-compressed from a ' +
      'versioned cache; send If-None-Match for a 304 that never touches the database.',
  })
  @ApiParam({ name: 'locale', example: 'en' })
  @ApiHeader({ name: 'If-None-Match', required: false, description: 'ETag from a previous export' })
  @ApiOkResponse({
    description: 'Translation document (raw JSON, no envelope).',
    content: {
      'application/json': {
        schema: { type: 'object', additionalProperties: true },
        example: { 'checkout.button.pay': 'Pay now' },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_MODIFIED, description: 'ETag matched; empty body.' })
  @ApiProblemResponses(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.TOO_MANY_REQUESTS,
  )
  async export(
    @Param('locale', LocaleCodePipe) locale: string,
    @Query() query: ExportQueryDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Headers('accept-encoding') acceptEncoding: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.exports.export({
      localeCode: locale,
      format: query.format ?? ExportFormat.Flat,
      tags: query.tags && { names: query.tags, mode: query.tagsMode ?? TagMatchMode.Any },
      ifNoneMatch,
      acceptsGzip: acceptsGzip(acceptEncoding),
    });

    appendVary(reply, this.vary);
    if (result.kind === 'not-modified') {
      await reply
        .status(HttpStatus.NOT_MODIFIED)
        .header('etag', result.etag)
        .header('cache-control', this.cacheControl)
        .send();
      return;
    }

    // Sent as a ready-made buffer: no interceptor re-serialises or re-compresses it.
    if (result.etag === undefined) void reply.header('cache-control', 'no-store');
    else void reply.header('etag', result.etag).header('cache-control', this.cacheControl);
    if (result.encoding === 'gzip') void reply.header('content-encoding', 'gzip');
    await reply
      .status(HttpStatus.OK)
      .header('content-type', result.contentType)
      .header('content-length', result.body.length)
      .send(result.body);
  }
}
