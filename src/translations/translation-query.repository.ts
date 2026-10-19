import { Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';
import {
  MIN_TRIGRAM_TERM_LENGTH,
  containsPattern,
  prefixPattern,
} from '../common/search/like-pattern';
import { InjectDb } from '../database/database.tokens';
import type { Database } from '../database/kysely.factory';
import { tagProbePredicate, tagSetPredicate } from './tag-filter.sql';
import type { SearchCriteria, TagFilter, TranslationKeyView } from './translation.model';

const hasTags = (tags: TagFilter | undefined): tags is TagFilter =>
  tags !== undefined && tags.names.length > 0;

/** Text or tag filters can match anywhere from all keys to none: they need the adaptive plan. */
const hasSelectiveFilter = ({ text, tags }: SearchCriteria): boolean =>
  text !== undefined || hasTags(tags);

export interface SearchResult {
  readonly items: readonly TranslationKeyView[];
  readonly hasMore: boolean;
}

/** Read side of the aggregate. A page (keys + values + tags) is one SQL statement. */
export abstract class TranslationQueryRepository {
  abstract findById(id: string): Promise<TranslationKeyView | undefined>;
  abstract search(criteria: SearchCriteria): Promise<SearchResult>;
}

interface HydratedRow {
  id: string;
  key: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  values: Record<string, string>;
  tags: string[];
}

const KEY_COLUMNS = ['id', 'key', 'description', 'created_at', 'updated_at'] as const;

/** `t.locale_id = (SELECT id FROM locales WHERE code = $1)` — an InitPlan, evaluated once. */
const localeIdOf = (code: string) =>
  sql<number>`(SELECT l.id FROM locales l WHERE l.code = ${code})`;

/**
 * Key-id span probed with the ordered plan before falling back to index-first.
 * ~2,000 keys × ~4 locales is a few ms of probing; if a term matches fewer than
 * a page of keys in that span, its matches are sparse enough to materialise.
 */
const PROBE_WINDOW_IDS = 2_000;

@Injectable()
export class KyselyTranslationQueryRepository extends TranslationQueryRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  async findById(id: string): Promise<TranslationKeyView | undefined> {
    const row = await this.db
      .selectFrom('translation_keys')
      .select(KEY_COLUMNS)
      .select([
        valuesOf('translation_keys.id', undefined).as('values'),
        tagsOf('translation_keys.id').as('tags'),
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toView(row);
  }

  /**
   * Keyset search with a bounded cost whatever the filters' selectivity.
   *
   * Postgres cannot estimate how many keys a word, substring or tag combination
   * matches, and the two possible plans fail in opposite cases (measured on
   * 200k rows):
   *  - walk keys in id order and probe each one (correlated EXISTS): < 1 ms
   *    for common filters, but rare or absent ones walk every key (90–190 ms
   *    per query, seconds under load);
   *  - compute the matching key set through the indexes first: a few ms for
   *    rare filters, but common ones materialise or aggregate most of a table
   *    (e.g. tagsMode=all aggregating 40k tag links per request).
   *
   * So: (1) probe a bounded window of key ids with the per-key predicates; a
   * common filter fills the page there. (2) Otherwise matches are sparse and
   * the set-based predicates are cheap.
   */
  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const rows = hasSelectiveFilter(criteria)
      ? await this.adaptivePage(criteria)
      : await this.keyPage(criteria, []);
    return {
      items: rows.slice(0, criteria.limit).map(toView),
      hasMore: rows.length > criteria.limit,
    };
  }

  private async adaptivePage(criteria: SearchCriteria): Promise<HydratedRow[]> {
    const windowEnd = BigInt(criteria.afterId ?? '0') + BigInt(PROBE_WINDOW_IDS);
    const probed = await this.keyPage(criteria, [
      sql<boolean>`translation_keys.id <= ${windowEnd.toString()}`,
      ...this.probePredicates(criteria),
    ]);
    if (probed.length > criteria.limit) return probed;
    return this.keyPage(criteria, this.setPredicates(criteria));
  }

  /** Per-key predicates, cheap when walking keys in id order. */
  private probePredicates({ text, tags, localeCode }: SearchCriteria): RawBuilder<boolean>[] {
    const predicates: RawBuilder<boolean>[] = [];
    if (text !== undefined) {
      const match = this.textCondition(text, localeCode);
      predicates.push(
        sql<boolean>`EXISTS (SELECT 1 FROM translations t WHERE t.translation_key_id = translation_keys.id AND ${match})`,
      );
    }
    if (hasTags(tags)) predicates.push(tagProbePredicate('translation_keys.id', tags));
    return predicates;
  }

  /** Set predicates, cheap when matches are sparse. */
  private setPredicates(criteria: SearchCriteria): RawBuilder<boolean>[] {
    if (criteria.text !== undefined) {
      return [
        this.indexFirstMatches(criteria, this.textCondition(criteria.text, criteria.localeCode)),
      ];
    }
    return hasTags(criteria.tags) ? [tagSetPredicate('translation_keys.id', criteria.tags)] : [];
  }

  /**
   * One keyset page (limit + 1 rows) filtered by cursor and key prefix plus the
   * given predicates, hydrated with values and tags in the *same* statement:
   * the page is selected first (inner query with LIMIT), so the per-key
   * aggregates run only for the ≤ limit + 1 rows returned.
   */
  private keyPage(
    { afterId, keyPrefix, limit, localeCode }: SearchCriteria,
    predicates: readonly RawBuilder<boolean>[],
  ): Promise<HydratedRow[]> {
    let page = this.db.selectFrom('translation_keys').select(KEY_COLUMNS);
    if (afterId !== undefined) page = page.where('id', '>', afterId);
    // C collation makes this a b-tree range scan; never a leading wildcard.
    if (keyPrefix !== undefined) page = page.where('key', 'like', prefixPattern(keyPrefix));
    for (const predicate of predicates) page = page.where(predicate);

    return this.db
      .selectFrom(
        page
          .orderBy('id')
          .limit(limit + 1)
          .as('page'),
      )
      .selectAll('page')
      .select([valuesOf('page.id', localeCode).as('values'), tagsOf('page.id').as('tags')])
      .orderBy('page.id')
      .execute();
  }

  /** Word match (tsvector GIN) OR substring match (trigram GIN, 3+ chars), optionally per locale. */
  private textCondition(text: string, localeCode: string | undefined): RawBuilder<boolean> {
    const wordMatch = sql<boolean>`t.search_vector @@ websearch_to_tsquery('simple', ${text})`;
    const anyMatch =
      text.length >= MIN_TRIGRAM_TERM_LENGTH
        ? sql<boolean>`(${wordMatch} OR t.value ILIKE ${containsPattern(text)})`
        : wordMatch;
    return localeCode === undefined
      ? anyMatch
      : sql<boolean>`${anyMatch} AND t.locale_id = ${localeIdOf(localeCode)}`;
  }

  /**
   * `id IN (materialised matching key ids)`. The MATERIALIZED fence forces the
   * GIN path; pushing the cursor/prefix/tag filters inside lets the planner
   * start from whichever index is most selective.
   */
  private indexFirstMatches(
    { afterId, keyPrefix, tags }: SearchCriteria,
    match: RawBuilder<boolean>,
  ): RawBuilder<boolean> {
    const filters: RawBuilder<boolean>[] = [match];
    if (afterId !== undefined) filters.push(sql<boolean>`t.translation_key_id > ${afterId}`);
    if (hasTags(tags)) filters.push(tagSetPredicate('t.translation_key_id', tags));
    // Only the prefix needs the key text; joining otherwise adds a needless key scan.
    const source =
      keyPrefix === undefined
        ? sql`translations t`
        : sql`translations t JOIN translation_keys k ON k.id = t.translation_key_id
              AND k.key LIKE ${prefixPattern(keyPrefix)}`;
    return sql<boolean>`translation_keys.id IN (
      WITH hits AS MATERIALIZED (
        SELECT DISTINCT t.translation_key_id FROM ${source}
        WHERE ${sql.join(filters, sql` AND `)}
      )
      SELECT translation_key_id FROM hits
    )`;
  }
}

/**
 * `{ "en": "…", "fr": "…" }` for one key, ordered by locale code, through the
 * (translation_key_id, locale_id) unique index. Optionally one locale only.
 */
function valuesOf(keyIdColumn: string, localeCode: string | undefined) {
  const localeFilter =
    localeCode === undefined ? sql`` : sql`AND t.locale_id = ${localeIdOf(localeCode)}`;
  return sql<Record<string, string>>`coalesce((
    SELECT json_object_agg(l.code, t.value ORDER BY l.code)
    FROM translations t JOIN locales l ON l.id = t.locale_id
    WHERE t.translation_key_id = ${sql.ref(keyIdColumn)} ${localeFilter}
  ), '{}'::json)`;
}

/** Sorted tag names for one key, through the (translation_key_id, tag_id) primary key. */
function tagsOf(keyIdColumn: string) {
  return sql<string[]>`coalesce((
    SELECT json_agg(tg.name ORDER BY tg.name)
    FROM translation_key_tags tkt JOIN tags tg ON tg.id = tkt.tag_id
    WHERE tkt.translation_key_id = ${sql.ref(keyIdColumn)}
  ), '[]'::json)`;
}

function toView(row: HydratedRow): TranslationKeyView {
  return {
    id: row.id,
    key: row.key,
    description: row.description,
    values: row.values,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
