import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainValidationError } from '../errors/errors';

const POSITIVE_BIGINT = /^[1-9]\d{0,18}$/;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Validates a bigint path id and keeps it as a decimal string (the wire and
 * driver representation), avoiding precision loss beyond 2^53.
 */
@Injectable()
export class ParseBigIntIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!POSITIVE_BIGINT.test(value) || BigInt(value) > PG_BIGINT_MAX) {
      throw new DomainValidationError([
        { field: 'id', message: 'id must be a positive 64-bit integer' },
      ]);
    }
    return value;
  }
}
