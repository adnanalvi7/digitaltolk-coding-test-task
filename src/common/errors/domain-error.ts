/**
 * Stable, transport-agnostic error categories. Services throw domain errors;
 * only the HTTP exception filter knows how a category maps to a status code.
 */
export enum DomainErrorKind {
  NotFound = 'not-found',
  Conflict = 'conflict',
  Validation = 'validation',
  Unauthenticated = 'unauthenticated',
  Forbidden = 'forbidden',
  RateLimited = 'rate-limited',
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;
  /** Client-safe, human-readable explanation. Never contains SQL or internals. */
  abstract readonly publicMessage: string;
  readonly fieldErrors: readonly FieldError[] = [];

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
