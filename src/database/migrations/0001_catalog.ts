import { type Kysely, sql } from 'kysely';

/**
 * Catalog schema: locales, translation keys, per-locale values and tags.
 * See docs/adr/0001-architecture.md for every index/deviation rationale.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END
    $$
  `.execute(db);

  await db.schema
    .createTable('locales')
    .addColumn('id', 'smallint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('code', 'varchar(12)', (col) => col.notNull().unique())
    .addColumn('name', 'varchar(64)', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('locales_code_format', sql`code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'`)
    .execute();

  // COLLATE "C": keys are ASCII [a-z0-9._-], so bytewise order is the correct
  // semantics, and it lets the UNIQUE b-tree serve `LIKE 'prefix%'` range
  // scans and the export's ORDER BY key without a second pattern_ops index.
  await db.schema
    .createTable('translation_keys')
    .addColumn('id', 'bigint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('key', sql`varchar(191) COLLATE "C"`, (col) => col.notNull().unique())
    .addColumn('description', 'varchar(500)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('translation_keys_key_format', sql`key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'`)
    .execute();

  await db.schema
    .createTable('translations')
    .addColumn('id', 'bigint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('translation_key_id', 'bigint', (col) =>
      col.notNull().references('translation_keys.id').onDelete('cascade'),
    )
    .addColumn('locale_id', 'smallint', (col) =>
      col.notNull().references('locales.id').onDelete('restrict'),
    )
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('search_vector', sql`tsvector`, (col) =>
      col.generatedAlwaysAs(sql`to_tsvector('simple', value)`).stored(),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('translations_key_locale_unique', ['translation_key_id', 'locale_id'])
    .addCheckConstraint('translations_value_length', sql`char_length(value) <= 65535`)
    .execute();

  // Export path: one locale's rows. No INCLUDE (value): b-tree tuples are
  // capped at ~2.7 kB and values may be up to 65,535 chars.
  await db.schema
    .createIndex('translations_locale_key_idx')
    .on('translations')
    .columns(['locale_id', 'translation_key_id'])
    .execute();
  await db.schema
    .createIndex('translations_search_vector_idx')
    .on('translations')
    .using('gin')
    .column('search_vector')
    .execute();
  await sql`CREATE INDEX translations_value_trgm_idx ON translations USING gin (value gin_trgm_ops)`.execute(
    db,
  );

  await db.schema
    .createTable('tags')
    .addColumn('id', 'smallint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('name', 'varchar(50)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('tags_name_format', sql`name ~ '^[a-z0-9-]{1,50}$'`)
    .execute();

  await db.schema
    .createTable('translation_key_tags')
    .addColumn('translation_key_id', 'bigint', (col) =>
      col.notNull().references('translation_keys.id').onDelete('cascade'),
    )
    .addColumn('tag_id', 'smallint', (col) =>
      col.notNull().references('tags.id').onDelete('cascade'),
    )
    .addPrimaryKeyConstraint('translation_key_tags_pk', ['translation_key_id', 'tag_id'])
    .execute();
  await db.schema
    .createIndex('translation_key_tags_tag_key_idx')
    .on('translation_key_tags')
    .columns(['tag_id', 'translation_key_id'])
    .execute();

  for (const table of ['locales', 'translation_keys', 'translations']) {
    await sql`
      CREATE TRIGGER ${sql.id(`${table}_set_updated_at`)}
      BEFORE UPDATE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('translation_key_tags').ifExists().execute();
  await db.schema.dropTable('tags').ifExists().execute();
  await db.schema.dropTable('translations').ifExists().execute();
  await db.schema.dropTable('translation_keys').ifExists().execute();
  await db.schema.dropTable('locales').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS set_updated_at()`.execute(db);
}
