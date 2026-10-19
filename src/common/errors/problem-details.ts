import { HttpException, HttpStatus } from '@nestjs/common';
import { numberProperty, stringProperty } from '../type-guards';
import { DomainError, DomainErrorKind, type FieldError } from './domain-error';
import { InvalidTokenError, RateLimitedError } from './errors';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
export const PROBLEM_TYPE_BASE = 'https://errors.translation-service.dev/';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly requestId: string;
  readonly errors?: readonly FieldError[];
}

export interface MappedProblem {
  readonly problem: ProblemDetails;
  readonly headers: Readonly<Record<string, string>>;
  /** Server errors are logged with the full exception; client errors are not. */
  readonly isServerError: boolean;
}

interface ProblemTemplate {
  readonly slug: string;
  readonly title: string;
  readonly detail: string;
}

const TEMPLATES: Readonly<Partial<Record<number, ProblemTemplate>>> = {
  [HttpStatus.BAD_REQUEST]: {
    slug: 'bad-request',
    title: 'Bad request',
    detail: 'The request could not be parsed.',
  },
  [HttpStatus.UNAUTHORIZED]: {
    slug: 'unauthenticated',
    title: 'Unauthenticated',
    detail: 'A valid bearer token is required.',
  },
  [HttpStatus.FORBIDDEN]: {
    slug: 'forbidden',
    title: 'Forbidden',
    detail: 'You are not allowed to perform this action.',
  },
  [HttpStatus.NOT_FOUND]: {
    slug: 'not-found',
    title: 'Not found',
    detail: 'The requested resource was not found.',
  },
  [HttpStatus.METHOD_NOT_ALLOWED]: {
    slug: 'method-not-allowed',
    title: 'Method not allowed',
    detail: 'The HTTP method is not supported for this resource.',
  },
  [HttpStatus.CONFLICT]: {
    slug: 'conflict',
    title: 'Conflict',
    detail: 'The request conflicts with the current state of the resource.',
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    slug: 'payload-too-large',
    title: 'Payload too large',
    detail: 'The request body exceeds the allowed size.',
  },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: {
    slug: 'unsupported-media-type',
    title: 'Unsupported media type',
    detail: 'Only application/json request bodies are accepted.',
  },
  [HttpStatus.UNPROCESSABLE_ENTITY]: {
    slug: 'validation',
    title: 'Validation failed',
    detail: 'Request contains invalid fields.',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    slug: 'rate-limited',
    title: 'Too many requests',
    detail: 'Rate limit exceeded. Retry after the number of seconds in Retry-After.',
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    slug: 'unavailable',
    title: 'Service unavailable',
    detail: 'The service is temporarily unavailable.',
  },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    slug: 'internal',
    title: 'Internal server error',
    detail: 'An unexpected error occurred.',
  },
};

const DOMAIN_STATUS: Readonly<Record<DomainErrorKind, HttpStatus>> = {
  [DomainErrorKind.NotFound]: HttpStatus.NOT_FOUND,
  [DomainErrorKind.Conflict]: HttpStatus.CONFLICT,
  [DomainErrorKind.Validation]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DomainErrorKind.Unauthenticated]: HttpStatus.UNAUTHORIZED,
  [DomainErrorKind.Forbidden]: HttpStatus.FORBIDDEN,
  [DomainErrorKind.RateLimited]: HttpStatus.TOO_MANY_REQUESTS,
};

/**
 * Postgres SQLSTATEs we translate. Anything else is a 500. Constraint names,
 * table names and SQL text are never echoed back to the client.
 */
const PG_STATUS: Readonly<Record<string, { status: HttpStatus; detail: string }>> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    detail: 'The resource conflicts with an existing one.',
  },
  // Documented choice: a dangling/still-referenced FK is a state conflict (409).
  '23503': {
    status: HttpStatus.CONFLICT,
    detail: 'The resource references, or is referenced by, another resource.',
  },
  '23514': { status: HttpStatus.UNPROCESSABLE_ENTITY, detail: 'Request contains invalid fields.' },
  '22001': { status: HttpStatus.UNPROCESSABLE_ENTITY, detail: 'Request contains invalid fields.' },
  '57014': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail: 'The request took too long to process.',
  },
};

const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;
const BEARER_CHALLENGE = 'Bearer realm="translation-service"';

function template(status: number): ProblemTemplate {
  return (
    TEMPLATES[status] ?? {
      slug: status >= SERVER_ERROR_MIN ? 'internal' : 'client-error',
      title: status >= SERVER_ERROR_MIN ? 'Internal server error' : 'Request error',
      detail:
        status >= SERVER_ERROR_MIN ? 'An unexpected error occurred.' : 'The request was rejected.',
    }
  );
}

/** Fastify raises plain errors carrying a 4xx `statusCode` (413, 415, bad JSON...). */
function clientStatusOf(error: unknown): number | undefined {
  const status = numberProperty(error, 'statusCode');
  return status !== undefined && status >= CLIENT_ERROR_MIN && status < SERVER_ERROR_MIN
    ? status
    : undefined;
}

interface Resolution {
  readonly status: number;
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
  readonly headers?: Readonly<Record<string, string>>;
}

function resolve(exception: unknown): Resolution {
  if (exception instanceof DomainError) {
    const status = DOMAIN_STATUS[exception.kind];
    const base: Resolution = { status, detail: exception.publicMessage };
    if (exception.fieldErrors.length > 0) return { ...base, errors: exception.fieldErrors };
    if (status === HttpStatus.UNAUTHORIZED) {
      const challenge =
        exception instanceof InvalidTokenError
          ? `${BEARER_CHALLENGE}, error="invalid_token"`
          : BEARER_CHALLENGE;
      return { ...base, headers: { 'WWW-Authenticate': challenge } };
    }
    if (exception instanceof RateLimitedError) {
      return { ...base, headers: { 'Retry-After': String(exception.retryAfterSeconds) } };
    }
    return base;
  }
  if (exception instanceof HttpException) {
    // Framework exceptions (route not found, throttler 429...). Their messages
    // may echo request details, so only the status is used.
    return { status: exception.getStatus() };
  }
  const clientStatus = clientStatusOf(exception);
  if (clientStatus !== undefined) return { status: clientStatus };
  const sqlState = stringProperty(exception, 'code');
  const pg = sqlState === undefined ? undefined : PG_STATUS[sqlState];
  if (pg) return { status: pg.status, detail: pg.detail };
  return { status: HttpStatus.INTERNAL_SERVER_ERROR };
}

/** Pure mapping from any thrown value to an RFC 7807 document plus headers. */
export function toProblemDetails(
  exception: unknown,
  context: { readonly instance: string; readonly requestId: string },
): MappedProblem {
  const resolution = resolve(exception);
  const tpl = template(resolution.status);
  const problem: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}${tpl.slug}`,
    title: tpl.title,
    status: resolution.status,
    detail: resolution.detail ?? tpl.detail,
    instance: context.instance,
    requestId: context.requestId,
    ...(resolution.errors ? { errors: resolution.errors } : {}),
  };
  return {
    problem,
    headers: resolution.headers ?? {},
    isServerError: resolution.status >= SERVER_ERROR_MIN,
  };
}
