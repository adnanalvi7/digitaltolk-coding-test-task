import type { IncomingMessage } from 'node:http';
import { DomainValidationError } from './errors/errors';
import { isAcceptableRequestId, resolveRequestId } from './http/request-id';
import { canonicalizeLocaleCode } from './locale-code';
import { LocaleCodePipe } from './pipes/locale-code.pipe';
import { ParseBigIntIdPipe } from './pipes/parse-bigint-id.pipe';
import {
  flattenValidationErrors,
  validationExceptionFactory,
} from './validation/validation-exception.factory';
import { SystemClock } from './clock';
import { envelope, pageEnvelope } from './http/envelope';

const rawRequest = (headers: Record<string, string>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

describe('request ids', () => {
  it('accepts ULIDs and UUIDs, rejects anything else', () => {
    expect(isAcceptableRequestId('01J9ZK3M5V7Q2X8Y4N6P0R1S2T')).toBe(true);
    expect(isAcceptableRequestId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isAcceptableRequestId('<script>')).toBe(false);
    expect(isAcceptableRequestId('x'.repeat(26))).toBe(false);
    expect(isAcceptableRequestId(undefined)).toBe(false);
  });

  it('reuses a valid incoming id and memoises per request', () => {
    const req = rawRequest({ 'x-request-id': '01J9ZK3M5V7Q2X8Y4N6P0R1S2T' });
    expect(resolveRequestId(req)).toBe('01J9ZK3M5V7Q2X8Y4N6P0R1S2T');
    expect(resolveRequestId(req)).toBe('01J9ZK3M5V7Q2X8Y4N6P0R1S2T');
  });

  it('replaces an invalid incoming id with a fresh UUID, stable for the request', () => {
    const req = rawRequest({ 'x-request-id': 'evil\nheader' });
    const id = resolveRequestId(req);
    expect(isAcceptableRequestId(id)).toBe(true);
    expect(resolveRequestId(req)).toBe(id);
  });
});

describe('locale codes', () => {
  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    ['pt-br', 'pt-BR'],
    ['zh-hans', 'zh-Hans'],
    ['sr-LATN', 'sr-Latn'],
  ])('canonicalises %s → %s', (input, expected) => {
    expect(canonicalizeLocaleCode(input)).toBe(expected);
  });

  it('LocaleCodePipe canonicalises valid codes and rejects invalid ones', () => {
    const pipe = new LocaleCodePipe();
    expect(pipe.transform('pt-br')).toBe('pt-BR');
    expect(pipe.transform('EN')).toBe('en');
    expect(() => pipe.transform('english')).toThrow(DomainValidationError);
    expect(() => pipe.transform('e')).toThrow(DomainValidationError);
  });
});

describe('ParseBigIntIdPipe', () => {
  const pipe = new ParseBigIntIdPipe();

  it('accepts positive 64-bit ids as strings', () => {
    expect(pipe.transform('1')).toBe('1');
    expect(pipe.transform('9223372036854775807')).toBe('9223372036854775807');
  });

  it.each(['0', '-1', '1.5', 'abc', '01', '9223372036854775808', '1e3', ' 1'])(
    'rejects %p',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(DomainValidationError);
    },
  );
});

describe('validation exception factory', () => {
  it('flattens nested class-validator errors into dotted paths', () => {
    const fields = flattenValidationErrors([
      {
        property: 'values',
        constraints: { isObject: 'values must be an object' },
        children: [
          { property: 'fr', constraints: { isString: 'fr must be a string' }, children: [] },
        ],
      },
      { property: 'key', children: [] },
    ]);
    expect(fields).toEqual([
      { field: 'values', message: 'values must be an object' },
      { field: 'values.fr', message: 'fr must be a string' },
    ]);
  });

  it('produces a domain validation error', () => {
    const error = validationExceptionFactory([
      { property: 'key', constraints: { matches: 'key must match' } },
    ]);
    expect(error).toBeInstanceOf(DomainValidationError);
    expect(error.fieldErrors).toEqual([{ field: 'key', message: 'key must match' }]);
  });
});

describe('small helpers', () => {
  it('SystemClock returns the current time', () => {
    const before = Date.now();
    expect(new SystemClock().now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('builds success envelopes', () => {
    expect(envelope({ a: 1 })).toEqual({ data: { a: 1 } });
    expect(pageEnvelope([1], { nextCursor: null, limit: 5 })).toEqual({
      data: [1],
      meta: { nextCursor: null, limit: 5 },
    });
  });
});
