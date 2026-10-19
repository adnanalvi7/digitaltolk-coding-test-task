import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LOCALE_CODE_PATTERN, parseLocaleCode } from '../../common/locale-code';
import { TagMatchMode } from '../translation.model';
import { CommaSeparatedList, KEY_MAX_LENGTH, MAX_TAGS, TAG_PATTERN } from './translation-fields';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const MAX_CURSOR_LENGTH = 200;
const KEY_PREFIX_PATTERN = /^[a-z0-9._-]+$/;

export class ListTranslationsQueryDto {
  @ApiPropertyOptional({
    description: 'Key prefix (index range scan), e.g. `checkout.`',
    example: 'checkout.',
    maxLength: KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(KEY_MAX_LENGTH)
  @Matches(KEY_PREFIX_PATTERN, { message: `key must match ${KEY_PREFIX_PATTERN.source}` })
  readonly key?: string;

  @ApiPropertyOptional({
    description:
      'Content search: word match (full-text, websearch syntax) or substring match (3+ chars).',
    example: 'pay',
    minLength: MIN_QUERY_LENGTH,
    maxLength: MAX_QUERY_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(MIN_QUERY_LENGTH, MAX_QUERY_LENGTH)
  readonly q?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated tag names.',
    type: String,
    example: 'mobile,web',
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
    description: 'Restrict content search and returned values to one locale.',
    example: 'fr',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCALE_CODE_PATTERN, { message: 'locale must be a BCP 47 code such as en or pt-BR' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseLocaleCode(value) ?? value) : value,
  )
  readonly locale?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from `meta.nextCursor`.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  readonly cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  readonly limit?: number;
}
