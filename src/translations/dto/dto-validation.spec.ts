import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { type ValidationError, useContainer, validate } from 'class-validator';
import type { LocaleDirectory } from '../../locales/locale-directory';
import { ExportQueryDto } from '../../export/dto/export-query.dto';
import { CreateLocaleDto } from '../../locales/dto/locale.dto';
import { LocaleValueMapConstraint } from '../validators/locale-value-map.validator';
import { ListTranslationsQueryDto } from './list-translations.query';
import { CreateTranslationDto, UpdateTranslationDto } from './translation-write.dto';

const directory = {
  resolveActive: (codes: readonly string[]) =>
    Promise.resolve(
      new Map(codes.filter((c) => c === 'en' || c === 'fr').map((c) => [c, 1] as [string, number])),
    ),
} as unknown as LocaleDirectory;
const constraint = new LocaleValueMapConstraint(directory);

beforeAll(() => {
  useContainer(
    {
      get: (cls: unknown) => (cls === LocaleValueMapConstraint ? constraint : undefined),
    },
    { fallback: true },
  );
});

async function errorsFor<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<{ instance: T; messages: string[] }> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: ValidationError[]): string[] =>
    list.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return { instance, messages: flatten(errors) };
}

describe('CreateTranslationDto', () => {
  const valid = { key: 'checkout.button.pay', values: { en: 'Pay', fr: 'Payer' } };

  it('accepts a valid payload and deduplicates tags', async () => {
    const { instance, messages } = await errorsFor(CreateTranslationDto, {
      ...valid,
      tags: ['web', 'web', 'mobile'],
    });
    expect(messages).toEqual([]);
    expect(instance.tags).toEqual(['web', 'mobile']);
  });

  it.each([
    ['uppercase key', { key: 'Checkout.Pay' }, /key must match/],
    ['leading separator', { key: '.a' }, /key must match/],
    ['double separator', { key: 'a..b' }, /key must match/],
    ['too long key', { key: 'a'.repeat(192) }, /191/],
    ['non-object values', { values: ['en'] }, /object mapping/],
    ['empty values', { values: {} }, /at least 1/],
    ['non-string value', { values: { en: 5 } }, /values\.en must be a string/],
    ['null value on create', { values: { en: null } }, /values\.en must be a string/],
    ['oversized value', { values: { en: 'x'.repeat(65_536) } }, /65535/],
    ['unknown locale', { values: { en: 'x', zz: 'y' } }, /unknown or inactive locale\(s\): zz/],
    ['too many tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, /20/],
    ['invalid tag', { tags: ['Not OK'] }, /each tag must match/],
    ['long description', { description: 'x'.repeat(501) }, /500/],
    ['unknown field', { admin: true }, /should not exist/],
  ])('rejects %s', async (_label, override, message) => {
    const { messages } = await errorsFor(CreateTranslationDto, { ...valid, ...override });
    expect(messages.join(' | ')).toMatch(message);
  });

  it('rejects more locales than the per-request cap', async () => {
    const values = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`l${i}`, 'x']));
    const { messages } = await errorsFor(CreateTranslationDto, { ...valid, values });
    expect(messages.join()).toMatch(/at most 100/);
  });
});

describe('UpdateTranslationDto', () => {
  it('accepts null values (removal), empty values and null description', async () => {
    const { messages } = await errorsFor(UpdateTranslationDto, {
      values: { fr: null },
      description: null,
    });
    expect(messages).toEqual([]);
    expect((await errorsFor(UpdateTranslationDto, { values: {} })).messages).toEqual([]);
  });

  it('rejects an attempt to change the immutable key', async () => {
    const { messages } = await errorsFor(UpdateTranslationDto, { key: 'new.key' });
    expect(messages.join()).toMatch(/should not exist/);
  });
});

describe('ListTranslationsQueryDto', () => {
  it('parses comma lists, repeated params and explicit numbers', async () => {
    const { instance, messages } = await errorsFor(ListTranslationsQueryDto, {
      tags: ['web,mobile', 'web', ' desktop '],
      limit: '25',
      tagsMode: 'all',
    });
    expect(messages).toEqual([]);
    expect(instance.tags).toEqual(['web', 'mobile', 'desktop']);
    expect(instance.limit).toBe(25);
  });

  it.each([
    ['limit above 100', { limit: '101' }],
    ['limit zero', { limit: '0' }],
    ['non-numeric limit', { limit: 'ten' }],
    ['one-char query', { q: 'a' }],
    ['huge query', { q: 'a'.repeat(101) }],
    ['bad tags mode', { tagsMode: 'some' }],
    ['bad locale', { locale: 'english' }],
    ['wildcard in key prefix', { key: 'check%' }],
    ['invalid tag', { tags: 'ok,NOT OK' }],
  ])('rejects %s', async (_label, query) => {
    expect((await errorsFor(ListTranslationsQueryDto, query)).messages.length).toBeGreaterThan(0);
  });
});

describe('ExportQueryDto', () => {
  it('accepts formats and tags', async () => {
    const { instance, messages } = await errorsFor(ExportQueryDto, {
      format: 'nested',
      tags: 'mobile',
    });
    expect(messages).toEqual([]);
    expect(instance.tags).toEqual(['mobile']);
  });

  it('rejects an unknown format', async () => {
    expect((await errorsFor(ExportQueryDto, { format: 'yaml' })).messages.join()).toMatch(/format/);
  });
});

describe('CreateLocaleDto', () => {
  it('canonicalises the code', async () => {
    const { instance, messages } = await errorsFor(CreateLocaleDto, { code: 'PT-br', name: 'P' });
    expect(messages).toEqual([]);
    expect(instance.code).toBe('pt-BR');
  });

  it('rejects malformed codes without transforming them', async () => {
    const { instance, messages } = await errorsFor(CreateLocaleDto, { code: 'english', name: 'E' });
    expect(messages.join()).toMatch(/BCP 47/);
    expect(instance.code).toBe('english');
  });
});

describe('LocaleValueMapConstraint', () => {
  it('falls back to a generic message when no failure was recorded', () => {
    expect(
      constraint.defaultMessage({
        object: {},
        property: 'values',
        value: undefined,
        constraints: [],
        targetName: 'X',
      }),
    ).toBe('values is invalid');
  });
});
