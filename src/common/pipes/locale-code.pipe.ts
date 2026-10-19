import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainValidationError } from '../errors/errors';
import { parseLocaleCode } from '../locale-code';

/** Validates a `:locale` / `:code` path segment and returns its canonical form. */
@Injectable()
export class LocaleCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const code = parseLocaleCode(value);
    if (code === undefined) {
      throw new DomainValidationError([
        { field: 'locale', message: 'locale must be a BCP 47 code such as en, fr or pt-BR' },
      ]);
    }
    return code;
  }
}
