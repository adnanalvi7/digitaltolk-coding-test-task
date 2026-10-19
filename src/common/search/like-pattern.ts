/**
 * Escapes LIKE/ILIKE metacharacters so user input is matched literally.
 * Postgres' default LIKE escape character is the backslash.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `prefix%` — index-friendly (b-tree range scan on a C-collated column). */
export function prefixPattern(term: string): string {
  return `${escapeLikeTerm(term)}%`;
}

/** `%term%` — served by the pg_trgm GIN index for terms of 3+ characters. */
export function containsPattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/** pg_trgm extracts no trigram from shorter strings, so the index cannot help. */
export const MIN_TRIGRAM_TERM_LENGTH = 3;
