import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb } from '../database/database.tokens';
import type { Database } from '../database/kysely.factory';
import type { DbExecutor } from '../database/transaction-runner';

export interface TagRecord {
  readonly id: number;
  readonly name: string;
}

export abstract class TagRepository {
  abstract findAll(): Promise<TagRecord[]>;
  /** Idempotently creates missing tags and returns the ids of all `names`. */
  abstract ensure(executor: DbExecutor, names: readonly string[]): Promise<number[]>;
}

@Injectable()
export class KyselyTagRepository extends TagRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  findAll(): Promise<TagRecord[]> {
    return this.db.selectFrom('tags').select(['id', 'name']).orderBy('name').execute();
  }

  async ensure(executor: DbExecutor, names: readonly string[]): Promise<number[]> {
    if (names.length === 0) return [];
    // One statement: insert what is missing, return ids of new + existing.
    // Only names that do not exist yet reach the INSERT: ON CONFLICT DO NOTHING
    // still consumes a sequence value per row, so inserting existing names on
    // every write would burn identity values (and exhaust the sequence).
    const { rows } = await sql<{ id: number }>`
      WITH input AS (SELECT DISTINCT unnest(${[...names]}::text[]) AS name),
      inserted AS (
        INSERT INTO tags (name)
        SELECT i.name FROM input i
        WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.name = i.name)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT t.id FROM tags t JOIN input USING (name)
    `.execute(executor);
    if (rows.length === new Set(names).size) return rows.map((row) => row.id);
    // A concurrent transaction committed one of the tags after our statement
    // snapshot was taken; a fresh statement sees it.
    const all = await executor
      .selectFrom('tags')
      .select('id')
      .where('name', '=', sql<string>`any(${[...names]}::text[])`)
      .execute();
    return all.map((row) => row.id);
  }
}
