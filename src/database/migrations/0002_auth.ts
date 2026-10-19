import { type Kysely, sql } from 'kysely';

/** Users and opaque API tokens (only the SHA-256 of a token is ever stored). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS citext`.execute(db);

  await db.schema
    .createTable('users')
    .addColumn('id', 'bigint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('email', sql`citext`, (col) => col.notNull().unique())
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'bigint', (col) => col.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('user_id', 'bigint', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(100)', (col) => col.notNull())
    .addColumn('token_hash', 'char(64)', (col) => col.notNull().unique())
    .addColumn('scopes', sql`text[]`, (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('api_tokens_user_id_idx')
    .on('api_tokens')
    .column('user_id')
    .execute();

  await sql`
    CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('api_tokens').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
