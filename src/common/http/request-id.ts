import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Crockford base32; the first char carries the top timestamp bits, so it is 0-7. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && (ULID.test(value) || UUID.test(value));
}

const assigned = new WeakMap<IncomingMessage, string>();

/**
 * Returns the request id for a raw request: the client's `X-Request-Id` if it
 * is a well-formed ULID/UUID, otherwise a fresh UUID. Memoised per request so
 * Fastify and the pino-http logger (which run at different lifecycle stages)
 * always agree on the same id.
 */
export function resolveRequestId(request: IncomingMessage): string {
  const existing = assigned.get(request);
  if (existing !== undefined) return existing;
  const incoming = request.headers[REQUEST_ID_HEADER];
  const id = isAcceptableRequestId(incoming) ? incoming : randomUUID();
  assigned.set(request, id);
  return id;
}
