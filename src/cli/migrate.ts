import { loadConfig } from '../config/app-config';
import { createKysely } from '../database/kysely.factory';
import { migrateDown, migrateToLatest } from '../database/migrations';
import { loadDotEnv } from './load-dot-env';

async function main(): Promise<void> {
  loadDotEnv();
  const direction = process.argv[2] ?? 'latest';
  if (direction !== 'latest' && direction !== 'down') {
    throw new Error(`Unknown direction "${direction}". Use "latest" or "down".`);
  }
  const db = createKysely(loadConfig(process.env).db, { applicationName: 'migrator' });
  try {
    const { results = [] } =
      direction === 'latest' ? await migrateToLatest(db) : await migrateDown(db);
    for (const result of results) {
      process.stdout.write(`${result.direction} ${result.migrationName}: ${result.status}\n`);
    }
    if (results.length === 0) process.stdout.write('Nothing to migrate.\n');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) process.stderr.write(`Caused by: ${cause.message}\n`);
  process.exitCode = 1;
});
