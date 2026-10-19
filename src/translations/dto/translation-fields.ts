import { Transform } from 'class-transformer';

export const KEY_MAX_LENGTH = 191;
export const KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const DESCRIPTION_MAX_LENGTH = 500;
export const TAG_PATTERN = /^[a-z0-9-]{1,50}$/;
export const MAX_TAGS = 20;

/** Removes duplicate strings while preserving first-seen order; leaves other input untouched. */
export const DedupeStrings = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? [...new Set(value)]
      : value,
  );

/** Accepts `a,b` and repeated `?tags=a&tags=b`, producing a deduplicated `string[]`. */
export const CommaSeparatedList = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    const parts = (Array.isArray(value) ? value : [value]).flatMap((part: unknown) =>
      typeof part === 'string' ? part.split(',') : [part],
    );
    return [
      ...new Set(
        parts
          .map((part) => (typeof part === 'string' ? part.trim() : part))
          .filter((part) => part !== ''),
      ),
    ];
  });
