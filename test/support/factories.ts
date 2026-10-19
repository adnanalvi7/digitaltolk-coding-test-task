import { sql } from 'kysely';
import type { Database } from '../../src/database/kysely.factory';

export interface TranslationKeyFixture {
  readonly key: string;
  readonly description: string | null;
  readonly values: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

let sequence = 0;

/** Pure builder: a valid translation-key payload with optional overrides. */
export function buildTranslationKey(
  overrides: Partial<TranslationKeyFixture> = {},
): TranslationKeyFixture {
  sequence += 1;
  return {
    key: `fixture.key.item_${sequence}`,
    description: null,
    values: { en: `Value ${sequence}` },
    tags: [],
    ...overrides,
  };
}

/** Persists a fixture directly (bypassing the API) and returns its id. */
export async function createTranslationKey(
  db: Database,
  overrides: Partial<TranslationKeyFixture> = {},
): Promise<{ id: string } & TranslationKeyFixture> {
  const fixture = buildTranslationKey(overrides);
  const { id } = await db
    .insertInto('translation_keys')
    .values({ key: fixture.key, description: fixture.description })
    .returning('id')
    .executeTakeFirstOrThrow();

  const codes = Object.keys(fixture.values);
  if (codes.length > 0) {
    await sql`
      INSERT INTO translations (translation_key_id, locale_id, value)
      SELECT ${id}::bigint, l.id, v.value
      FROM unnest(${codes}::text[], ${Object.values(fixture.values)}::text[]) AS v(code, value)
      JOIN locales l ON l.code = v.code
    `.execute(db);
  }
  if (fixture.tags.length > 0) {
    await sql`
      WITH t AS (
        INSERT INTO tags (name) SELECT unnest(${[...fixture.tags]}::text[])
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      )
      INSERT INTO translation_key_tags (translation_key_id, tag_id) SELECT ${id}::bigint, id FROM t
    `.execute(db);
  }
  return { id, ...fixture };
}
