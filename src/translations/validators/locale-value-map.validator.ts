import { Injectable } from '@nestjs/common';
import {
  type ValidationArguments,
  type ValidationOptions,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';
import { isRecord } from '../../common/type-guards';
import { LocaleDirectory } from '../../locales/locale-directory';

export const MAX_VALUE_LENGTH = 65_535;
export const MAX_LOCALES_PER_REQUEST = 100;

export interface LocaleValueMapOptions {
  /** Minimum number of locale entries (1 on create, 0 on update). */
  readonly minEntries: number;
  /** Whether `null` is accepted as "remove this locale's value" (update only). */
  readonly allowNull: boolean;
}

/**
 * Validates `values: { [localeCode]: string }`: shape, size limits, and that
 * every key is an existing, *active* locale (checked against the cached
 * locale directory, with a reload on miss).
 */
@ValidatorConstraint({ name: 'localeValueMap', async: true })
@Injectable()
export class LocaleValueMapConstraint implements ValidatorConstraintInterface {
  /** The specific failure per validated DTO instance, read back by defaultMessage. */
  private readonly failures = new WeakMap<object, string>();

  constructor(private readonly locales: LocaleDirectory) {}

  async validate(value: unknown, args: ValidationArguments): Promise<boolean> {
    const failure = await this.findFailure(value, args.constraints[0] as LocaleValueMapOptions);
    if (failure === undefined) return true;
    this.failures.set(args.object, failure);
    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.failures.get(args.object) ?? `${args.property} is invalid`;
  }

  private async findFailure(
    value: unknown,
    { minEntries, allowNull }: LocaleValueMapOptions,
  ): Promise<string | undefined> {
    if (!isRecord(value)) return 'values must be an object mapping locale codes to strings';
    const entries = Object.entries(value);
    if (entries.length < minEntries) return `values must contain at least ${minEntries} locale(s)`;
    if (entries.length > MAX_LOCALES_PER_REQUEST) {
      return `values must contain at most ${MAX_LOCALES_PER_REQUEST} locales`;
    }
    for (const [code, text] of entries) {
      const validText = typeof text === 'string' && text.length <= MAX_VALUE_LENGTH;
      if (!validText && !(allowNull && text === null)) {
        return `values.${code} must be a string of at most ${MAX_VALUE_LENGTH} characters${
          allowNull ? ' or null' : ''
        }`;
      }
    }
    const known = await this.locales.resolveActive(entries.map(([code]) => code));
    const unknown = entries.map(([code]) => code).filter((code) => !known.has(code));
    return unknown.length > 0
      ? `values contains unknown or inactive locale(s): ${unknown.join(', ')}`
      : undefined;
  }
}

export function IsLocaleValueMap(
  options: LocaleValueMapOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [options],
      ...(validationOptions ? { options: validationOptions } : {}),
      validator: LocaleValueMapConstraint,
    });
  };
}
