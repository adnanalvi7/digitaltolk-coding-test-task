/** BCP 47 subset accepted by the service, in canonical casing: language[-Script|-REGION]. */
export const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
export const LOCALE_CODE_MAX_LENGTH = 12;

/** Same shape, any casing: what clients may send before canonicalisation. */
const LOCALE_CODE_INPUT = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
const REGION_LENGTH = 2;

/**
 * Canonical casing so `pt-br` and `pt-BR` are the same locale:
 * 2-letter subtag = region (upper case), 3-4 letters = script (title case).
 */
export function canonicalizeLocaleCode(code: string): string {
  const [language = '', subtag] = code.split('-', 2);
  if (subtag === undefined) return language.toLowerCase();
  const normalizedSubtag =
    subtag.length === REGION_LENGTH
      ? subtag.toUpperCase()
      : `${subtag.charAt(0).toUpperCase()}${subtag.slice(1).toLowerCase()}`;
  return `${language.toLowerCase()}-${normalizedSubtag}`;
}

/** @returns the canonical code, or undefined if the input is not a supported locale code. */
export function parseLocaleCode(input: string): string | undefined {
  return LOCALE_CODE_INPUT.test(input) ? canonicalizeLocaleCode(input) : undefined;
}
