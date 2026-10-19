import { type RawBuilder, sql } from 'kysely';
import { type TagFilter, TagMatchMode } from './translation.model';

/*
 * Tag predicates on a translation-key id column, in two shapes with opposite
 * cost profiles (see TranslationQueryRepository.search):
 *
 *  - probe:   per-key EXISTS lookups on translation_key_tags' primary key.
 *             Cheap per key, so ideal when walking keys in id order and the
 *             tags are common; a full walk when they are rare.
 *  - set:     the set of matching key ids computed once via the
 *             (tag_id, translation_key_id) index. Cost scales with how many
 *             keys carry the tags, so ideal when they are rare.
 *
 * `keyIdColumn` is always a compile-time constant from our own code, never input.
 */

const distinctNames = (filter: TagFilter): string[] => [...new Set(filter.names)];

/** EXISTS form: any tag → one EXISTS; all tags → one EXISTS per tag. */
export function tagProbePredicate(keyIdColumn: string, filter: TagFilter): RawBuilder<boolean> {
  const keyId = sql.ref(keyIdColumn);
  const existsWith = (names: readonly string[]) => sql<boolean>`EXISTS (
    SELECT 1 FROM translation_key_tags tkt JOIN tags tg ON tg.id = tkt.tag_id
    WHERE tkt.translation_key_id = ${keyId} AND tg.name = ANY(${[...names]}::text[])
  )`;
  const names = distinctNames(filter);
  return filter.mode === TagMatchMode.Any
    ? existsWith(names)
    : sql<boolean>`(${sql.join(
        names.map((name) => existsWith([name])),
        sql` AND `,
      )})`;
}

/** Set form: `id IN (keys carrying any / all of the tags)`. */
export function tagSetPredicate(keyIdColumn: string, filter: TagFilter): RawBuilder<boolean> {
  const names = distinctNames(filter);
  const keyId = sql.ref(keyIdColumn);
  const tagged = sql`
    FROM translation_key_tags tkt JOIN tags tg ON tg.id = tkt.tag_id
    WHERE tg.name = ANY(${names}::text[])
  `;
  return filter.mode === TagMatchMode.Any
    ? sql<boolean>`${keyId} IN (SELECT tkt.translation_key_id ${tagged})`
    : sql<boolean>`${keyId} IN (
        SELECT tkt.translation_key_id ${tagged}
        GROUP BY tkt.translation_key_id
        HAVING count(*) = ${names.length}
      )`;
}
