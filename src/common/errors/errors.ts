import { DomainError, DomainErrorKind, type FieldError } from './domain-error';

const GENERIC_NOT_FOUND = 'The requested resource was not found.';

export class TranslationKeyNotFoundError extends DomainError {
  readonly kind = DomainErrorKind.NotFound;
  readonly publicMessage = GENERIC_NOT_FOUND;
  constructor(id: string) {
    super(`Translation key ${id} not found`);
  }
}

export class LocaleNotFoundError extends DomainError {
  readonly kind = DomainErrorKind.NotFound;
  readonly publicMessage = GENERIC_NOT_FOUND;
  constructor(code: string) {
    super(`Locale ${code} not found`);
  }
}

export class TranslationKeyAlreadyExistsError extends DomainError {
  readonly kind = DomainErrorKind.Conflict;
  readonly publicMessage: string;
  constructor(key: string) {
    super(`Translation key ${key} already exists`);
    this.publicMessage = `A translation key named "${key}" already exists.`;
  }
}

export class LocaleAlreadyExistsError extends DomainError {
  readonly kind = DomainErrorKind.Conflict;
  readonly publicMessage: string;
  constructor(code: string) {
    super(`Locale ${code} already exists`);
    this.publicMessage = `A locale with code "${code}" already exists.`;
  }
}

/** Raised when input passes DTO shape checks but fails a domain rule. */
export class DomainValidationError extends DomainError {
  readonly kind = DomainErrorKind.Validation;
  readonly publicMessage = 'Request contains invalid fields.';
  override readonly fieldErrors: readonly FieldError[];
  constructor(fieldErrors: readonly FieldError[]) {
    super(`Validation failed: ${fieldErrors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    this.fieldErrors = fieldErrors;
  }
}

export class InvalidCursorError extends DomainError {
  readonly kind = DomainErrorKind.Validation;
  readonly publicMessage = 'Request contains invalid fields.';
  override readonly fieldErrors: readonly FieldError[] = [
    { field: 'cursor', message: 'cursor is malformed or was not issued by this API' },
  ];
  constructor() {
    super('Invalid pagination cursor');
  }
}

export class InvalidCredentialsError extends DomainError {
  readonly kind = DomainErrorKind.Unauthenticated;
  readonly publicMessage = 'Invalid email or password.';
  constructor() {
    super('Invalid credentials');
  }
}

export class InvalidTokenError extends DomainError {
  readonly kind = DomainErrorKind.Unauthenticated;
  readonly publicMessage = 'A valid bearer token is required.';
  constructor(reason: string) {
    super(`Token rejected: ${reason}`);
  }
}

export class InsufficientScopeError extends DomainError {
  readonly kind = DomainErrorKind.Forbidden;
  readonly publicMessage: string;
  constructor(readonly requiredScopes: readonly string[]) {
    super(`Missing scopes: ${requiredScopes.join(', ')}`);
    this.publicMessage = `This token lacks the required scope(s): ${requiredScopes.join(', ')}.`;
  }
}

/** Too many failed authentication attempts from one client. */
export class RateLimitedError extends DomainError {
  readonly kind = DomainErrorKind.RateLimited;
  readonly publicMessage =
    'Too many failed authentication attempts. Retry after the number of seconds in Retry-After.';
  constructor(readonly retryAfterSeconds: number) {
    super(`Rate limited for ${retryAfterSeconds}s`);
  }
}

export class ScopeNotGrantableError extends DomainError {
  readonly kind = DomainErrorKind.Forbidden;
  readonly publicMessage: string;
  constructor(readonly scopes: readonly string[]) {
    super(`User cannot be granted scopes: ${scopes.join(', ')}`);
    this.publicMessage = `You are not allowed to request the scope(s): ${scopes.join(', ')}.`;
  }
}
