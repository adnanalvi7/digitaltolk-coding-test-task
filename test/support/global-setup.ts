import { Client } from 'pg';
import { createKysely } from '../../src/database/kysely.factory';
import { migrateToLatest } from '../../src/database/migrations';
import { TEST_DATABASE_URL, testConfig } from './test-config';

/** Creates the test database if needed and migrates it once per run. */
export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  const db = createKysely(testConfig().db);
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
