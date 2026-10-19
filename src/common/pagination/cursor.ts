import { InvalidCursorError } from '../errors/errors';
import { numberProperty, stringProperty } from '../type-guards';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 200;
const BIGINT_ID = /^[1-9]\d{0,18}$/;

interface CursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly id: string;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  const id = stringProperty(value, 'id');
  return numberProperty(value, 'v') === CURSOR_VERSION && id !== undefined && BIGINT_ID.test(id);
}

/** Opaque keyset cursor: base64url(JSON{v, id}) where id is the last row's id. */
export function encodeCursor(lastId: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, id: lastId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** @returns the id to continue after. Throws {@link InvalidCursorError} on any tampering. */
export function decodeCursor(cursor: string): string {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[\w-]+$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!isCursorPayload(parsed)) throw new InvalidCursorError();
  return parsed.id;
}
