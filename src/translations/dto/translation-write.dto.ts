import { ApiProperty, type ApiPropertyOptions, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsLocaleValueMap, MAX_VALUE_LENGTH } from '../validators/locale-value-map.validator';
import {
  DESCRIPTION_MAX_LENGTH,
  DedupeStrings,
  KEY_MAX_LENGTH,
  KEY_PATTERN,
  MAX_TAGS,
  TAG_PATTERN,
} from './translation-fields';

const TAGS_DOC: ApiPropertyOptions = {
  description: `Context tags (deduplicated). Unknown tags are created. Max ${MAX_TAGS}.`,
  type: [String],
  example: ['mobile', 'web'],
  maxItems: MAX_TAGS,
};

export class CreateTranslationDto {
  @ApiProperty({
    description: 'Dot-notation key; immutable after creation.',
    example: 'checkout.button.pay',
    pattern: KEY_PATTERN.source,
    maxLength: KEY_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(KEY_MAX_LENGTH)
  @Matches(KEY_PATTERN, { message: `key must match ${KEY_PATTERN.source}` })
  readonly key!: string;

  @ApiPropertyOptional({
    example: 'Primary CTA on the payment step',
    maxLength: DESCRIPTION_MAX_LENGTH,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  readonly description?: string | null;

  @ApiProperty({
    description: 'Locale code → translated text. Every code must be an active locale.',
    type: 'object',
    additionalProperties: { type: 'string', maxLength: MAX_VALUE_LENGTH },
    example: { en: 'Pay now', fr: 'Payer maintenant' },
  })
  @IsLocaleValueMap({ minEntries: 1, allowNull: false })
  readonly values!: Record<string, string>;

  @ApiPropertyOptional(TAGS_DOC)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @Matches(TAG_PATTERN, { each: true, message: `each tag must match ${TAG_PATTERN.source}` })
  @DedupeStrings()
  readonly tags?: string[];
}

export class UpdateTranslationDto {
  @ApiPropertyOptional({
    description: 'Set to null to clear.',
    maxLength: DESCRIPTION_MAX_LENGTH,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  readonly description?: string | null;

  @ApiPropertyOptional({
    description:
      'Merged by locale (upsert). A null value removes that locale; omitted locales are untouched.',
    type: 'object',
    additionalProperties: { type: 'string', maxLength: MAX_VALUE_LENGTH, nullable: true },
    example: { fr: 'Payer', es: null },
  })
  @IsOptional()
  @IsLocaleValueMap({ minEntries: 0, allowNull: true })
  readonly values?: Record<string, string | null>;

  @ApiPropertyOptional({ ...TAGS_DOC, description: 'Replaces the full tag set when provided.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @Matches(TAG_PATTERN, { each: true, message: `each tag must match ${TAG_PATTERN.source}` })
  @DedupeStrings()
  readonly tags?: string[];
}
