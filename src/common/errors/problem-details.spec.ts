import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import {
  DomainValidationError,
  InsufficientScopeError,
  InvalidCredentialsError,
  InvalidCursorError,
  InvalidTokenError,
  LocaleAlreadyExistsError,
  LocaleNotFoundError,
  ScopeNotGrantableError,
  TranslationKeyAlreadyExistsError,
  TranslationKeyNotFoundError,
} from './errors';
import { PROBLEM_TYPE_BASE, toProblemDetails } from './problem-details';

const ctx = { instance: '/api/v1/x', requestId: 'req-1' };
const map = (error: unknown) => toProblemDetails(error, ctx);

describe('toProblemDetails', () => {
  it.each([
    [new TranslationKeyNotFoundError('7'), HttpStatus.NOT_FOUND, 'not-found'],
    [new LocaleNotFoundError('xx'), HttpStatus.NOT_FOUND, 'not-found'],
    [new TranslationKeyAlreadyExistsError('a.b'), HttpStatus.CONFLICT, 'conflict'],
    [new LocaleAlreadyExistsError('fr'), HttpStatus.CONFLICT, 'conflict'],
    [new InsufficientScopeError(['export:read']), HttpStatus.FORBIDDEN, 'forbidden'],
    [new ScopeNotGrantableError(['locales:write']), HttpStatus.FORBIDDEN, 'forbidden'],
  ])('maps %p to %i', (error, status, slug) => {
    const { problem, isServerError } = map(error);
    expect(problem.status).toBe(status);
    expect(problem.type).toBe(`${PROBLEM_TYPE_BASE}${slug}`);
    expect(problem.instance).toBe('/api/v1/x');
    expect(problem.requestId).toBe('req-1');
    expect(isServerError).toBe(false);
  });

  it('uses a generic not-found message that leaks no identifiers', () => {
    expect(map(new TranslationKeyNotFoundError('123')).problem.detail).toBe(
      'The requested resource was not found.',
    );
  });

  it('includes field errors for validation failures', () => {
    const { problem } = map(new DomainValidationError([{ field: 'key', message: 'bad' }]));
    expect(problem.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem.errors).toEqual([{ field: 'key', message: 'bad' }]);
    expect(map(new InvalidCursorError()).problem.errors?.[0]?.field).toBe('cursor');
  });

  it('adds a Bearer challenge (with invalid_token) for rejected tokens', () => {
    const { problem, headers } = map(new InvalidTokenError('expired'));
    expect(problem.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(headers['WWW-Authenticate']).toBe(
      'Bearer realm="translation-service", error="invalid_token"',
    );
  });

  it('adds a plain Bearer challenge for bad credentials', () => {
    expect(map(new InvalidCredentialsError()).headers['WWW-Authenticate']).toBe(
      'Bearer realm="translation-service"',
    );
  });

  it('maps framework exceptions by status only, never echoing their message', () => {
    const { problem } = map(new NotFoundException('Cannot GET /secret-route?token=abc'));
    expect(problem.status).toBe(HttpStatus.NOT_FOUND);
    expect(JSON.stringify(problem)).not.toContain('secret-route');
  });

  it('maps throttling to 429', () => {
    expect(map(new ThrottlerException()).problem).toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      type: `${PROBLEM_TYPE_BASE}rate-limited`,
    });
  });

  it.each([
    [HttpStatus.PAYLOAD_TOO_LARGE, 'payload-too-large'],
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported-media-type'],
    [HttpStatus.BAD_REQUEST, 'bad-request'],
    [HttpStatus.METHOD_NOT_ALLOWED, 'method-not-allowed'],
    [418, 'client-error'],
  ])('maps Fastify client errors with statusCode %i', (statusCode, slug) => {
    const error = Object.assign(new Error('FST internal text'), { statusCode, code: 'FST_X' });
    const { problem } = map(error);
    expect(problem.status).toBe(statusCode);
    expect(problem.type).toBe(`${PROBLEM_TYPE_BASE}${slug}`);
    expect(problem.detail).not.toContain('FST internal text');
  });

  it.each([
    ['23505', HttpStatus.CONFLICT],
    ['23503', HttpStatus.CONFLICT],
    ['23514', HttpStatus.UNPROCESSABLE_ENTITY],
    ['22001', HttpStatus.UNPROCESSABLE_ENTITY],
    ['57014', HttpStatus.SERVICE_UNAVAILABLE],
  ])('maps Postgres SQLSTATE %s to %i without leaking SQL', (code, status) => {
    const pgError = Object.assign(new Error('duplicate key value violates "users_email_key"'), {
      code,
      table: 'users',
    });
    const { problem } = map(pgError);
    expect(problem.status).toBe(status);
    expect(JSON.stringify(problem)).not.toMatch(/users|duplicate key/);
  });

  it.each([
    ['an unknown error', new Error('boom: password=hunter2')],
    ['an unmapped SQLSTATE', Object.assign(new Error('x'), { code: '42P01' })],
    ['a thrown string', 'oops'],
    ['a 5xx statusCode', Object.assign(new Error('x'), { statusCode: 502 })],
    ['a non-numeric statusCode', Object.assign(new Error('x'), { statusCode: '404' })],
  ])('maps %s to a generic 500', (_label, error) => {
    const { problem, isServerError } = map(error);
    expect(problem.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(problem.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(problem)).not.toContain('hunter2');
    expect(isServerError).toBe(true);
  });

  it('falls back to a generic template for unexpected 5xx HttpExceptions', () => {
    const { problem } = map(new HttpException('gateway', HttpStatus.BAD_GATEWAY));
    expect(problem).toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      title: 'Internal server error',
    });
  });
});
