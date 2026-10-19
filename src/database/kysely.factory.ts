import { Kysely, type KyselyPlugin, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { AppConfig } from '../config/app-config';
import type { DB } from './schema.generated';

export type Database = Kysely<DB>;

export interface CreateKyselyOptions {
  readonly applicationName?: string;
  readonly plugins?: readonly KyselyPlugin[];
}

/**
 * Builds the pg pool + Kysely instance. Server-side timeouts are set per
 * connection so a slow query or an abandoned transaction can never pin a
 * pooled connection indefinitely.
 */
export function createKysely(
  dbConfig: AppConfig['db'],
  { applicationName = 'translation-service', plugins = [] }: CreateKyselyOptions = {},
): Database {
  const pool = new Pool({
    connectionString: dbConfig.url,
    max: dbConfig.poolMax,
    application_name: applicationName,
    options: [
      `-c statement_timeout=${dbConfig.statementTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${dbConfig.idleInTransactionTimeoutMs}`,
    ].join(' '),
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [...plugins] });
}
