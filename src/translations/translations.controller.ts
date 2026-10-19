import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { RequireScopes } from '../auth/auth.decorators';
import { TokenScope } from '../auth/token-scope';
import {
  type DataEnvelope,
  type PageEnvelope,
  ApiEnvelopedResponse,
  envelope,
  pageEnvelope,
} from '../common/http/envelope';
import {
  AUTHENTICATED_ERRORS,
  ApiProblemResponses,
  BODY_ERRORS,
} from '../common/http/problem-responses';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { DEFAULT_PAGE_SIZE, ListTranslationsQueryDto } from './dto/list-translations.query';
import { TranslationKeyResponse } from './dto/translation-key.response';
import { CreateTranslationDto, UpdateTranslationDto } from './dto/translation-write.dto';
import { TagMatchMode } from './translation.model';
import { TranslationsService } from './translations.service';

const ID_PARAM = { name: 'id', description: 'Translation key id (bigint as string)', example: '1' };

/** Thin adapter: DTO → command → use case → response DTO. No SQL, no rules. */
@ApiTags('translations')
@ApiBearerAuth()
@Controller('translations')
export class TranslationsController {
  constructor(private readonly translations: TranslationsService) {}

  @Get()
  @RequireScopes(TokenScope.TranslationsRead)
  @ApiOperation({ summary: 'List and search translation keys (keyset pagination)' })
  @ApiEnvelopedResponse(TranslationKeyResponse, {
    status: HttpStatus.OK,
    description: 'A page of keys',
    paginated: true,
  })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS, HttpStatus.UNPROCESSABLE_ENTITY)
  async list(
    @Query() query: ListTranslationsQueryDto,
  ): Promise<PageEnvelope<TranslationKeyResponse>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const page = await this.translations.search({
      keyPrefix: query.key,
      text: query.q,
      tags: query.tags && { names: query.tags, mode: query.tagsMode ?? TagMatchMode.Any },
      localeCode: query.locale,
      cursor: query.cursor,
      limit,
    });
    return pageEnvelope(
      page.items.map((item) => new TranslationKeyResponse(item)),
      { nextCursor: page.nextCursor, limit },
    );
  }

  @Post()
  @RequireScopes(TokenScope.TranslationsWrite)
  @ApiOperation({ summary: 'Create a key with its per-locale values and tags' })
  @ApiEnvelopedResponse(TranslationKeyResponse, {
    status: HttpStatus.CREATED,
    description: 'Created',
  })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS, ...BODY_ERRORS, HttpStatus.CONFLICT)
  async create(
    @Body() dto: CreateTranslationDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DataEnvelope<TranslationKeyResponse>> {
    const view = await this.translations.create({
      key: dto.key,
      description: dto.description ?? null,
      values: new Map(Object.entries(dto.values)),
      tags: dto.tags ?? [],
    });
    void reply.header('Location', `/api/v1/translations/${view.id}`);
    return envelope(new TranslationKeyResponse(view));
  }

  @Get(':id')
  @RequireScopes(TokenScope.TranslationsRead)
  @ApiOperation({ summary: 'Show one key with all values and tags' })
  @ApiParam(ID_PARAM)
  @ApiEnvelopedResponse(TranslationKeyResponse, { status: HttpStatus.OK, description: 'OK' })
  @ApiProblemResponses(
    ...AUTHENTICATED_ERRORS,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async show(
    @Param('id', ParseBigIntIdPipe) id: string,
  ): Promise<DataEnvelope<TranslationKeyResponse>> {
    return envelope(new TranslationKeyResponse(await this.translations.get(id)));
  }

  @Patch(':id')
  @RequireScopes(TokenScope.TranslationsWrite)
  @ApiOperation({ summary: 'Partially update a key (values merge by locale)' })
  @ApiParam(ID_PARAM)
  @ApiEnvelopedResponse(TranslationKeyResponse, { status: HttpStatus.OK, description: 'Updated' })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS, ...BODY_ERRORS, HttpStatus.NOT_FOUND)
  async update(
    @Param('id', ParseBigIntIdPipe) id: string,
    @Body() dto: UpdateTranslationDto,
  ): Promise<DataEnvelope<TranslationKeyResponse>> {
    const view = await this.translations.update({
      id,
      description: dto.description,
      values: dto.values && new Map(Object.entries(dto.values)),
      tags: dto.tags,
    });
    return envelope(new TranslationKeyResponse(view));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes(TokenScope.TranslationsWrite)
  @ApiOperation({ summary: 'Delete a key and all its values' })
  @ApiParam(ID_PARAM)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiProblemResponses(
    ...AUTHENTICATED_ERRORS,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async remove(@Param('id', ParseBigIntIdPipe) id: string): Promise<void> {
    await this.translations.delete(id);
  }
}
