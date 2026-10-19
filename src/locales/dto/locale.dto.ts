import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import {
  LOCALE_CODE_MAX_LENGTH,
  LOCALE_CODE_PATTERN,
  parseLocaleCode,
} from '../../common/locale-code';
import type { LocaleRecord } from '../locale.repository';

const LOCALE_NAME_MAX_LENGTH = 64;

export class CreateLocaleDto {
  @ApiProperty({
    description: 'BCP 47 code (language[-Script|-REGION]); stored in canonical casing.',
    example: 'pt-BR',
    pattern: LOCALE_CODE_PATTERN.source,
    maxLength: LOCALE_CODE_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(LOCALE_CODE_MAX_LENGTH)
  @Matches(LOCALE_CODE_PATTERN, { message: 'code must be a BCP 47 code such as en, fr or pt-BR' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseLocaleCode(value) ?? value) : value,
  )
  readonly code!: string;

  @ApiProperty({ example: 'Português (Brasil)', maxLength: LOCALE_NAME_MAX_LENGTH })
  @IsString()
  @Length(1, LOCALE_NAME_MAX_LENGTH)
  readonly name!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}

export class UpdateLocaleDto {
  @ApiPropertyOptional({ example: 'Français', maxLength: LOCALE_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Length(1, LOCALE_NAME_MAX_LENGTH)
  readonly name?: string;

  @ApiPropertyOptional({ description: 'Inactive locales are rejected on writes and not exported.' })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}

export class LocaleResponse {
  @ApiProperty({ example: 'fr' })
  readonly code: string;

  @ApiProperty({ example: 'Français' })
  readonly name: string;

  @ApiProperty({ example: true })
  readonly isActive: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(record: LocaleRecord) {
    this.code = record.code;
    this.name = record.name;
    this.isActive = record.isActive;
    this.createdAt = record.createdAt.toISOString();
    this.updatedAt = record.updatedAt.toISOString();
  }
}
