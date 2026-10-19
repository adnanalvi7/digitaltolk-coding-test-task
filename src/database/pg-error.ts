import { stringProperty } from '../common/type-guards';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** Narrowing helper for node-postgres `DatabaseError`s by SQLSTATE. */
export function isPgError(error: unknown, sqlState: string): boolean {
  return stringProperty(error, 'code') === sqlState;
}
