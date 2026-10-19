import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { TranslationKeyAlreadyExistsError } from '../common/errors/errors';
import { PG_UNIQUE_VIOLATION, isPgError } from '../database/pg-error';
import type { DbExecutor } from '../database/transaction-runner';

export interface LocaleValue {
  readonly localeId: number;
  readonly value: string;
}

/** Write side of the translation-key aggregate. Every method runs on the caller's executor. */
export abstract class TranslationRepository {
  abstract insertKey(
    executor: DbExecutor,
    key: string,
    description: string | null,
  ): Promise<string>;
  /**
   * Locks the key row, optionally sets its description and bumps updated_at.
   * @returns false when the key does not exist.
   */
  abstract touchKey(
    executor: DbExecutor,
    id: string,
    description: string | null | undefined,
  ): Promise<boolean>;
  abstract deleteKey(executor: DbExecutor, id: string): Promise<boolean>;
  abstract upsertValues(
    executor: DbExecutor,
    keyId: string,
    values: readonly LocaleValue[],
  ): Promise<void>;
  abstract deleteValues(
    executor: DbExecutor,
    keyId: string,
    localeIds: readonly number[],
  ): Promise<void>;
  abstract replaceTags(
    executor: DbExecutor,
    keyId: string,
    tagIds: readonly number[],
  ): Promise<void>;
}

@Injectable()
export class KyselyTranslationRepository extends TranslationRepository {
  async insertKey(executor: DbExecutor, key: string, description: string | null): Promise<string> {
    try {
      const row = await executor
        .insertInto('translation_keys')
        .values({ key, description })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    } catch (error: unknown) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) throw new TranslationKeyAlreadyExistsError(key);
      throw error;
    }
  }

  async touchKey(
    executor: DbExecutor,
    id: string,
    description: string | null | undefined,
  ): Promise<boolean> {
    const row = await executor
      .updateTable('translation_keys')
      .set((eb) => ({
        description: description === undefined ? eb.ref('description') : description,
      }))
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async deleteKey(executor: DbExecutor, id: string): Promise<boolean> {
    const result = await executor
      .deleteFrom('translation_keys')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** One statement for any number of locales: INSERT … SELECT unnest … ON CONFLICT DO UPDATE. */
  async upsertValues(
    executor: DbExecutor,
    keyId: string,
    values: readonly LocaleValue[],
  ): Promise<void> {
    if (values.length === 0) return;
    await sql`
      INSERT INTO translations (translation_key_id, locale_id, value)
      SELECT ${keyId}::bigint, u.locale_id, u.value
      FROM unnest(${values.map((v) => v.localeId)}::smallint[], ${values.map((v) => v.value)}::text[])
        AS u(locale_id, value)
      ON CONFLICT (translation_key_id, locale_id)
      DO UPDATE SET value = excluded.value
      WHERE translations.value IS DISTINCT FROM excluded.value
    `.execute(executor);
  }

  async deleteValues(
    executor: DbExecutor,
    keyId: string,
    localeIds: readonly number[],
  ): Promise<void> {
    if (localeIds.length === 0) return;
    await executor
      .deleteFrom('translations')
      .where('translation_key_id', '=', keyId)
      .where('locale_id', '=', sql<number>`any(${[...localeIds]}::smallint[])`)
      .execute();
  }

  /** Two statements regardless of tag count: prune removed links, insert new ones. */
  async replaceTags(executor: DbExecutor, keyId: string, tagIds: readonly number[]): Promise<void> {
    const ids = [...tagIds];
    await executor
      .deleteFrom('translation_key_tags')
      .where('translation_key_id', '=', keyId)
      .where('tag_id', '<>', sql<number>`all(${ids}::int[])`)
      .execute();
    if (ids.length === 0) return;
    await sql`
      INSERT INTO translation_key_tags (translation_key_id, tag_id)
      SELECT ${keyId}::bigint, unnest(${ids}::int[])
      ON CONFLICT DO NOTHING
    `.execute(executor);
  }
}
