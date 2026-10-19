import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import {
  CommaSeparatedList,
  MAX_TAGS,
  TAG_PATTERN,
} from '../../translations/dto/translation-fields';
import { TagMatchMode } from '../../translations/translation.model';
import { ExportFormat } from '../formatters/export-formatter';

export class ExportQueryDto {
  @ApiPropertyOptional({
    description: 'Only export keys carrying these tags (comma-separated).',
    type: String,
    example: 'mobile',
  })
  @IsOptional()
  @CommaSeparatedList()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @Matches(TAG_PATTERN, { each: true, message: `each tag must match ${TAG_PATTERN.source}` })
  readonly tags?: string[];

  @ApiPropertyOptional({ enum: TagMatchMode, default: TagMatchMode.Any })
  @IsOptional()
  @IsEnum(TagMatchMode)
  readonly tagsMode?: TagMatchMode;

  @ApiPropertyOptional({
    enum: ExportFormat,
    default: ExportFormat.Flat,
    description: '`flat` = { "a.b": "…" }; `nested` = { a: { b: "…" } } (Vue i18n style).',
  })
  @IsOptional()
  @IsEnum(ExportFormat)
  readonly format?: ExportFormat;
}
