import { type Kysely, sql } from 'kysely';

/**
 * Append-only log of committed catalog changes. Its max(id) is the
 * authoritative catalog version: a row is inserted inside every catalog write
 * transaction, so a rollback leaves no trace and a commit always advances it.
 * Append-only avoids a single hot row that would serialise all writers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('catalog_changes')
    .addColumn('id', 'bigint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('committed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  // Version continuity for databases that already hold data.
  await sql`INSERT INTO catalog_changes DEFAULT VALUES`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('catalog_changes').ifExists().execute();
}
