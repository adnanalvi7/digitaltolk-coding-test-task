import type { ValidationError } from 'class-validator';
import type { FieldError } from '../errors/domain-error';
import { DomainValidationError } from '../errors/errors';

/** Depth-first flattening of class-validator's tree into dotted field paths. */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): FieldError[] {
  return errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

export function validationExceptionFactory(errors: ValidationError[]): DomainValidationError {
  return new DomainValidationError(flattenValidationErrors(errors));
}
