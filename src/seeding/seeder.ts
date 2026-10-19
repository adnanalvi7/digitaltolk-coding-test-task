import { sql } from 'kysely';
import type { Database } from '../database/kysely.factory';
import { KyselyTagRepository } from '../tags/tag.repository';
import { createPrng, pick } from './prng';
import { LOCALE_NAMES, MODULES, SECTIONS, wordsFor } from './vocabulary';

export interface SeedOptions {
  readonly keys: number;
  readonly locales: readonly string[];
  readonly tags: readonly string[];
  readonly batchSize: number;
  /** Truncate catalog tables and rebuild GIN indexes around the bulk load. */
  readonly fresh: boolean;
  readonly seed: number;
}

export interface SeedProgress {
  readonly keysWritten: number;
  readonly totalKeys: number;
}

export interface SeedResult {
  readonly keys: number;
  readonly translations: number;
  readonly elapsedMs: number;
}

export interface SeederHooks {
  readonly onProgress?: (progress: SeedProgress) => void;
  /** Called once data is committed, e.g. to bump the export catalog version. */
  readonly afterSeed?: () => Promise<void>;
}

const MIN_WORDS = 2;
const EXTRA_WORDS = 5;
const SECOND_TAG_PROBABILITY = 0.35;

/** GIN indexes are much cheaper to build once than to maintain row by row. */
const GIN_INDEXES = [
  {
    name: 'translations_search_vector_idx',
    create: sql`CREATE INDEX IF NOT EXISTS translations_search_vector_idx ON translations USING gin (search_vector)`,
  },
  {
    name: 'translations_value_trgm_idx',
    create: sql`CREATE INDEX IF NOT EXISTS translations_value_trgm_idx ON translations USING gin (value gin_trgm_ops)`,
  },
] as const;

/**
 * Deterministic bulk loader. Every batch is three set-based statements
 * (`INSERT … SELECT FROM unnest(...)`) inside one transaction — never a row
 * at a time. Re-running with the same options is idempotent.
 */
export class Seeder {
  constructor(private readonly db: Database) {}

  async run(options: SeedOptions, hooks: SeederHooks = {}): Promise<SeedResult> {
    const startedAt = performance.now();
    const random = createPrng(options.seed);
    const localeIds = await this.ensureLocales(options.locales);
    const tagIds = await this.ensureTags(options.tags);

    if (options.fresh) await this.prepareFreshLoad();

    let translations = 0;
    for (let offset = 0; offset < options.keys; offset += options.batchSize) {
      const size = Math.min(options.batchSize, options.keys - offset);
      translations += await this.writeBatch(offset, size, localeIds, tagIds, random);
      hooks.onProgress?.({ keysWritten: offset + size, totalKeys: options.keys });
    }

    if (options.fresh) await this.restoreIndexes();
    await sql`ANALYZE translation_keys, translations, translation_key_tags, tags, locales`.execute(
      this.db,
    );
    await hooks.afterSeed?.();
    return { keys: options.keys, translations, elapsedMs: performance.now() - startedAt };
  }

  private async ensureLocales(codes: readonly string[]): Promise<Map<string, number>> {
    // Insert only missing codes, so re-runs never consume identity values.
    await sql`
      INSERT INTO locales (code, name)
      SELECT v.code, v.name
      FROM unnest(${[...codes]}::text[], ${codes.map((code) => LOCALE_NAMES[code] ?? code)}::text[])
        AS v(code, name)
      WHERE NOT EXISTS (SELECT 1 FROM locales l WHERE l.code = v.code)
      ON CONFLICT (code) DO NOTHING
    `.execute(this.db);
    const rows = await this.db
      .selectFrom('locales')
      .select(['id', 'code'])
      .where('code', 'in', [...codes])
      .execute();
    return new Map(rows.map((row) => [row.code, row.id]));
  }

  /** Same idempotent, sequence-safe upsert the API uses; sorted for a reproducible PRNG draw. */
  private async ensureTags(names: readonly string[]): Promise<number[]> {
    const ids = await new KyselyTagRepository(this.db).ensure(this.db, names);
    return ids.sort((a, b) => a - b);
  }

  private async prepareFreshLoad(): Promise<void> {
    await sql`TRUNCATE translation_key_tags, translations, translation_keys RESTART IDENTITY`.execute(
      this.db,
    );
    for (const index of GIN_INDEXES) {
      await sql`DROP INDEX IF EXISTS ${sql.id(index.name)}`.execute(this.db);
    }
  }

  private async restoreIndexes(): Promise<void> {
    for (const index of GIN_INDEXES) await index.create.execute(this.db);
  }

  private async writeBatch(
    offset: number,
    size: number,
    localeIds: ReadonlyMap<string, number>,
    tagIds: readonly number[],
    random: () => number,
  ): Promise<number> {
    const keys = Array.from({ length: size }, (_, i) => keyName(offset + i));
    const descriptions = keys.map((key) => `Seeded string ${key}`);

    return this.db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO translation_keys (key, description)
        SELECT * FROM unnest(${keys}::text[], ${descriptions}::text[])
        ON CONFLICT (key) DO NOTHING
      `.execute(trx);
      const { rows } = await sql<{ id: string; key: string }>`
        SELECT id, key FROM translation_keys WHERE key = ANY(${keys}::text[])
      `.execute(trx);
      const idByKey = new Map(rows.map((row) => [row.key, row.id]));

      const valueKeyIds: string[] = [];
      const valueLocaleIds: number[] = [];
      const values: string[] = [];
      const linkKeyIds: string[] = [];
      const linkTagIds: number[] = [];

      keys.forEach((key, i) => {
        const keyId = idByKey.get(key);
        if (keyId === undefined) return;
        for (const [code, localeId] of localeIds) {
          valueKeyIds.push(keyId);
          valueLocaleIds.push(localeId);
          values.push(phrase(random, code, offset + i));
        }
        for (const tagId of chooseTags(random, tagIds)) {
          linkKeyIds.push(keyId);
          linkTagIds.push(tagId);
        }
      });

      await sql`
        INSERT INTO translations (translation_key_id, locale_id, value)
        SELECT * FROM unnest(${valueKeyIds}::bigint[], ${valueLocaleIds}::smallint[], ${values}::text[])
        ON CONFLICT (translation_key_id, locale_id)
        DO UPDATE SET value = excluded.value
        WHERE translations.value IS DISTINCT FROM excluded.value
      `.execute(trx);
      if (linkKeyIds.length > 0) {
        await sql`
          INSERT INTO translation_key_tags (translation_key_id, tag_id)
          SELECT * FROM unnest(${linkKeyIds}::bigint[], ${linkTagIds}::int[])
          ON CONFLICT DO NOTHING
        `.execute(trx);
      }
      return values.length;
    });
  }
}

/** Deterministic, unique, valid key: `module.section.item_{n}`. */
export function keyName(n: number): string {
  const module = MODULES[n % MODULES.length] ?? 'misc';
  const section = SECTIONS[Math.floor(n / MODULES.length) % SECTIONS.length] ?? 'text';
  return `${module}.${section}.item_${n}`;
}

function phrase(random: () => number, locale: string, n: number): string {
  const words = wordsFor(locale);
  const count = MIN_WORDS + Math.floor(random() * EXTRA_WORDS);
  const text = Array.from({ length: count }, () => pick(random, words)).join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} #${n}`;
}

function chooseTags(random: () => number, tagIds: readonly number[]): number[] {
  if (tagIds.length === 0) return [];
  const first = pick(random, tagIds);
  const second = pick(random, tagIds);
  return random() < SECOND_TAG_PROBABILITY && second !== first ? [first, second] : [first];
}
