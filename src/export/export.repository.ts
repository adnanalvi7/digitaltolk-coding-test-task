import { Injectable } from '@nestjs/common';
import { InjectDb } from '../database/database.tokens';
import type { Database } from '../database/kysely.factory';
import { tagSetPredicate } from '../translations/tag-filter.sql';
import type { TagFilter } from '../translations/translation.model';
import type { ExportEntry } from './formatters/export-formatter';

/** Read port dedicated to the export path (kept apart from the CRUD repositories). */
export abstract class ExportRepository {
  abstract fetchEntries(localeId: number, tags: TagFilter | undefined): Promise<ExportEntry[]>;
}

@Injectable()
export class KyselyExportRepository extends ExportRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  /**
   * One query, no ORM hydration:
   *   SELECT tk.key, t.value FROM translations t JOIN translation_keys tk …
   *   WHERE t.locale_id = $1 [AND tag predicate] ORDER BY tk.key
   * Bytewise ORDER BY (C collation) gives deterministic output for ETags.
   */
  async fetchEntries(localeId: number, tags: TagFilter | undefined): Promise<ExportEntry[]> {
    let query = this.db
      .selectFrom('translations as t')
      .innerJoin('translation_keys as tk', 'tk.id', 't.translation_key_id')
      .select(['tk.key', 't.value'])
      .where('t.locale_id', '=', localeId);
    if (tags !== undefined && tags.names.length > 0) {
      // The export reads a whole locale, so the set form is the natural fit.
      query = query.where(tagSetPredicate('tk.id', tags));
    }
    return query.orderBy('tk.key').execute();
  }
}
