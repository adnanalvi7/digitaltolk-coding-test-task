import { ApiProperty } from '@nestjs/swagger';
import type { TranslationKeyView } from '../translation.model';

export class TranslationKeyResponse {
  @ApiProperty({ description: 'bigint id, serialised as a string', example: '1024' })
  readonly id: string;

  @ApiProperty({ example: 'checkout.button.pay' })
  readonly key: string;

  @ApiProperty({ type: String, nullable: true, example: 'Primary CTA on the payment step' })
  readonly description: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { en: 'Pay now', fr: 'Payer maintenant' },
  })
  readonly values: Readonly<Record<string, string>>;

  @ApiProperty({ type: [String], example: ['mobile', 'web'] })
  readonly tags: readonly string[];

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(view: TranslationKeyView) {
    this.id = view.id;
    this.key = view.key;
    this.description = view.description;
    this.values = view.values;
    this.tags = view.tags;
    this.createdAt = view.createdAt.toISOString();
    this.updatedAt = view.updatedAt.toISOString();
  }
}
