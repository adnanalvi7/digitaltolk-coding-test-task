import {
  type Kysely,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  Migrator,
} from 'kysely';
import * as m0001 from './0001_catalog';
import * as m0002 from './0002_auth';
import * as m0003 from './0003_catalog_changes';
import * as m0004 from './0004_widen_tag_ids';

/**
 * Static provider: migrations are imported explicitly so the same code works
 * from compiled `dist/` and from TypeScript sources under test, with a stable,
 * reviewable order.
 */
class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      '0001_catalog': m0001,
      '0002_auth': m0002,
      '0003_catalog_changes': m0003,
      '0004_widen_tag_ids': m0004,
    });
  }
}

/** Generic so it accepts the typed application instance as well as `Kysely<unknown>`. */
export function createMigrator<Schema>(db: Kysely<Schema>): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider() });
}

export class MigrationFailedError extends Error {
  constructor(cause: unknown) {
    super('Database migration failed', { cause });
    this.name = 'MigrationFailedError';
  }
}

function unwrap(resultSet: MigrationResultSet): MigrationResultSet {
  if (resultSet.error !== undefined) {
    throw new MigrationFailedError(resultSet.error);
  }
  return resultSet;
}

export async function migrateToLatest<Schema>(db: Kysely<Schema>): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateToLatest());
}

export async function migrateDown<Schema>(db: Kysely<Schema>): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateDown());
}
