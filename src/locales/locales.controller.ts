import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { RequireScopes } from '../auth/auth.decorators';
import { TokenScope } from '../auth/token-scope';
import { type DataEnvelope, ApiEnvelopedResponse, envelope } from '../common/http/envelope';
import {
  AUTHENTICATED_ERRORS,
  ApiProblemResponses,
  BODY_ERRORS,
} from '../common/http/problem-responses';
import { LocaleCodePipe } from '../common/pipes/locale-code.pipe';
import { CreateLocaleDto, LocaleResponse, UpdateLocaleDto } from './dto/locale.dto';
import { LocalesService } from './locales.service';

@ApiTags('locales')
@ApiBearerAuth()
@Controller('locales')
export class LocalesController {
  constructor(private readonly locales: LocalesService) {}

  @Get()
  @RequireScopes(TokenScope.TranslationsRead)
  @ApiOperation({ summary: 'List all locales (active and inactive)' })
  @ApiEnvelopedResponse(LocaleResponse, { status: HttpStatus.OK, description: 'OK', isArray: true })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS)
  async list(): Promise<DataEnvelope<LocaleResponse[]>> {
    const locales = await this.locales.list();
    return envelope(locales.map((locale) => new LocaleResponse(locale)));
  }

  @Post()
  @RequireScopes(TokenScope.LocalesWrite)
  @ApiOperation({ summary: 'Add a language (no migration or deploy required)' })
  @ApiEnvelopedResponse(LocaleResponse, { status: HttpStatus.CREATED, description: 'Created' })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS, ...BODY_ERRORS, HttpStatus.CONFLICT)
  async create(
    @Body() dto: CreateLocaleDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DataEnvelope<LocaleResponse>> {
    const locale = await this.locales.create({
      code: dto.code,
      name: dto.name,
      isActive: dto.isActive ?? true,
    });
    void reply.header('Location', `/api/v1/locales/${encodeURIComponent(locale.code)}`);
    return envelope(new LocaleResponse(locale));
  }

  @Patch(':code')
  @RequireScopes(TokenScope.LocalesWrite)
  @ApiOperation({ summary: 'Rename, activate or deactivate a locale' })
  @ApiParam({ name: 'code', example: 'fr' })
  @ApiEnvelopedResponse(LocaleResponse, { status: HttpStatus.OK, description: 'Updated' })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS, ...BODY_ERRORS, HttpStatus.NOT_FOUND)
  async update(
    @Param('code', LocaleCodePipe) code: string,
    @Body() dto: UpdateLocaleDto,
  ): Promise<DataEnvelope<LocaleResponse>> {
    const locale = await this.locales.update(code, { name: dto.name, isActive: dto.isActive });
    return envelope(new LocaleResponse(locale));
  }
}
