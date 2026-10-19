import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequireScopes } from '../auth/auth.decorators';
import { TokenScope } from '../auth/token-scope';
import { type DataEnvelope, ApiEnvelopedResponse, envelope } from '../common/http/envelope';
import { AUTHENTICATED_ERRORS, ApiProblemResponses } from '../common/http/problem-responses';
import { type TagRecord, TagRepository } from './tag.repository';

export class TagResponse {
  @ApiProperty({ example: 'mobile' })
  readonly name: string;

  constructor(record: TagRecord) {
    this.name = record.name;
  }
}

@ApiTags('tags')
@ApiBearerAuth()
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagRepository) {}

  @Get()
  @RequireScopes(TokenScope.TranslationsRead)
  @ApiOperation({ summary: 'List tags (created implicitly when attached to a key)' })
  @ApiEnvelopedResponse(TagResponse, { status: HttpStatus.OK, description: 'OK', isArray: true })
  @ApiProblemResponses(...AUTHENTICATED_ERRORS)
  async list(): Promise<DataEnvelope<TagResponse[]>> {
    const tags = await this.tags.findAll();
    return envelope(tags.map((tag) => new TagResponse(tag)));
  }
}
