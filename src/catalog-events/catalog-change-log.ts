import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb } from '../database/database.tokens';
import type { Database } from '../database/kysely.factory';
import type { DbExecutor } from '../database/transaction-runner';

/**
 * Authoritative catalog version, stored in Postgres: max(id) of an append-only
 * change log written inside each catalog write transaction.
 */
export abstract class CatalogChangeLog {
  /** Appends a change inside `executor`'s transaction; returns the new version. */
  abstract record(executor: DbExecutor): Promise<number>;
  /** Latest committed version (0 when nothing has been recorded). */
  abstract latest(): Promise<number>;
  /** Deletes all but the newest `keep` rows; the log is only needed for max(id). */
  abstract prune(keep: number): Promise<void>;
}

@Injectable()
export class KyselyCatalogChangeLog extends CatalogChangeLog {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  async record(executor: DbExecutor): Promise<number> {
    const row = await executor
      .insertInto('catalog_changes')
      .defaultValues()
      .returning('id')
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  async latest(): Promise<number> {
    const row = await this.db
      .selectFrom('catalog_changes')
      .select((eb) => eb.fn.coalesce(eb.fn.max('id'), sql<string>`0`).as('version'))
      .executeTakeFirstOrThrow();
    return Number(row.version);
  }

  async prune(keep: number): Promise<void> {
    await sql`
      DELETE FROM catalog_changes
      WHERE id < (SELECT coalesce(max(id), 0) - ${keep} FROM catalog_changes)
    `.execute(this.db);
  }
}
