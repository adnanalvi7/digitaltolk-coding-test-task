import { HttpStatus, applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export class FieldErrorDto {
  @ApiProperty({ example: 'key' })
  readonly field!: string;

  @ApiProperty({ example: 'key must match /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/' })
  readonly message!: string;
}

/** RFC 7807 problem document returned for every error. */
export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://errors.translation-service.dev/validation' })
  readonly type!: string;

  @ApiProperty({ example: 'Validation failed' })
  readonly title!: string;

  @ApiProperty({ example: 422 })
  readonly status!: number;

  @ApiProperty({ example: 'Request contains invalid fields.' })
  readonly detail!: string;

  @ApiProperty({ example: '/api/v1/translations' })
  readonly instance!: string;

  @ApiProperty({ example: '0f8fad5b-d9cb-469f-a165-70867728950e' })
  readonly requestId!: string;

  @ApiPropertyOptional({ type: [FieldErrorDto] })
  readonly errors?: FieldErrorDto[];
}

const DESCRIPTIONS: Readonly<Partial<Record<HttpStatus, string>>> = {
  [HttpStatus.UNAUTHORIZED]: 'Missing, malformed, unknown, expired or revoked bearer token.',
  [HttpStatus.FORBIDDEN]: 'The token lacks a required scope.',
  [HttpStatus.NOT_FOUND]: 'Resource not found.',
  [HttpStatus.CONFLICT]: 'Conflicts with an existing resource.',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Request body exceeds the configured limit (1 MiB).',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Request body is not application/json.',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Validation failed; see `errors`.',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Rate limit exceeded; see the Retry-After header.',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Unexpected server error (details are only logged).',
};

/** Documents problem+json responses for the given statuses (500 is always added). */
export function ApiProblemResponses(...statuses: HttpStatus[]): MethodDecorator & ClassDecorator {
  const all = [...new Set([...statuses, HttpStatus.INTERNAL_SERVER_ERROR])];
  return applyDecorators(
    ApiExtraModels(ProblemDetailsDto, FieldErrorDto),
    ...all.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? 'Error',
        content: {
          'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailsDto) } },
        },
      }),
    ),
  );
}

/** Statuses every authenticated endpoint can produce. */
export const AUTHENTICATED_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
] as const;

/** Statuses every JSON-body endpoint can additionally produce. */
export const BODY_ERRORS = [
  HttpStatus.PAYLOAD_TOO_LARGE,
  HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  HttpStatus.UNPROCESSABLE_ENTITY,
] as const;
