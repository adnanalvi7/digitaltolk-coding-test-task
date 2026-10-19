import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { ALL_TOKEN_SCOPES, type TokenScope } from '../token-scope';

const EMAIL_MAX_LENGTH = 254;
/** Upper bound protects argon2 from oversized-input CPU abuse. */
const PASSWORD_MAX_LENGTH = 1_024;
const TOKEN_NAME_MAX_LENGTH = 100;
const MIN_TOKEN_TTL_SECONDS = 60;

export class CreateTokenDto {
  @ApiProperty({ example: 'admin@example.com', maxLength: EMAIL_MAX_LENGTH })
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  readonly email!: string;

  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @Length(1, PASSWORD_MAX_LENGTH)
  readonly password!: string;

  @ApiProperty({ example: 'ci-pipeline', maxLength: TOKEN_NAME_MAX_LENGTH })
  @IsString()
  @Length(1, TOKEN_NAME_MAX_LENGTH)
  readonly name!: string;

  @ApiPropertyOptional({
    description:
      'Scopes to grant. Omit to get every scope the user may grant. ' +
      'Narrow it (e.g. ["export:read"]) for least-privilege tokens.',
    enum: ALL_TOKEN_SCOPES,
    isArray: true,
    example: ALL_TOKEN_SCOPES,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_TOKEN_SCOPES, { each: true })
  readonly scopes?: TokenScope[];

  @ApiPropertyOptional({
    description: 'Token lifetime in seconds. Defaults to AUTH_TOKEN_DEFAULT_TTL_SECONDS.',
    minimum: MIN_TOKEN_TTL_SECONDS,
    example: 86_400,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_TOKEN_TTL_SECONDS)
  readonly ttlSeconds?: number;
}
