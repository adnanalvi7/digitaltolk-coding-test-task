import { type Type, applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export class PageMetaDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor for the next page; null when this is the last page.',
    type: String,
    nullable: true,
    example: 'eyJ2IjoxLCJpZCI6IjEwMCJ9',
  })
  readonly nextCursor!: string | null;

  @ApiProperty({ example: 50 })
  readonly limit!: number;
}

export interface DataEnvelope<T> {
  readonly data: T;
}

export interface PageEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: PageMetaDto;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export function pageEnvelope<T>(
  data: readonly T[],
  meta: { nextCursor: string | null; limit: number },
): PageEnvelope<T> {
  return { data, meta };
}

interface EnvelopedResponseOptions {
  readonly status: number;
  readonly description: string;
  readonly isArray?: boolean;
  readonly paginated?: boolean;
}

/** Documents a `{ data, meta? }` success envelope around `model` in OpenAPI. */
export function ApiEnvelopedResponse<T>(
  model: Type<T>,
  { status, description, isArray = false, paginated = false }: EnvelopedResponseOptions,
): MethodDecorator & ClassDecorator {
  const data =
    isArray || paginated
      ? { type: 'array', items: { $ref: getSchemaPath(model) } }
      : { $ref: getSchemaPath(model) };
  const properties: Record<string, object> = { data };
  if (paginated) properties.meta = { $ref: getSchemaPath(PageMetaDto) };
  return applyDecorators(
    ApiExtraModels(model, PageMetaDto),
    ApiResponse({
      status,
      description,
      schema: {
        type: 'object',
        required: paginated ? ['data', 'meta'] : ['data'],
        properties,
      },
    }),
  );
}
