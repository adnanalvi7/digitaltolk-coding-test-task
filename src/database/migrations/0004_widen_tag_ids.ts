import { type Kysely, sql } from 'kysely';

/**
 * tags.id was smallint (max 32,767). Combined with identity values consumed by
 * `ON CONFLICT DO NOTHING` inserts, tag ids could be exhausted, after which
 * every tagged write fails. Widen the key, its foreign key, and the identity
 * sequence to integer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE translation_key_tags ALTER COLUMN tag_id TYPE integer`.execute(db);
  await sql`ALTER TABLE tags ALTER COLUMN id TYPE integer`.execute(db);
  await sql`ALTER SEQUENCE tags_id_seq AS integer MAXVALUE 2147483647`.execute(db);
  // ALTER COLUMN TYPE rewrites the tables and discards their planner
  // statistics; without this, tag-filter plans degrade until autovacuum runs.
  await sql`ANALYZE tags, translation_key_tags`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER SEQUENCE tags_id_seq AS smallint MAXVALUE 32767`.execute(db);
  await sql`ALTER TABLE tags ALTER COLUMN id TYPE smallint`.execute(db);
  await sql`ALTER TABLE translation_key_tags ALTER COLUMN tag_id TYPE smallint`.execute(db);
}
