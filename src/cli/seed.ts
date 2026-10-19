import { parseArgs } from 'node:util';
import { Argon2PasswordHasher } from '../auth/password-hasher';
import { KyselyUserRepository } from '../auth/repositories/user.repository';
import { KyselyCatalogChangeLog } from '../catalog-events/catalog-change-log';
import { RedisVersionStore } from '../catalog-events/version-store';
import { MS_PER_SECOND } from '../common/units';
import { loadConfig } from '../config/app-config';
import { createKysely } from '../database/kysely.factory';
import { migrateToLatest } from '../database/migrations';
import { createRedis } from '../redis/redis.module';
import { provisionAdmin } from '../seeding/admin-provisioner';
import { Seeder } from '../seeding/seeder';
import { loadDotEnv } from './load-dot-env';

const USAGE =
  'npm run seed -- --keys=50000 --locales=en,fr,es,de --tags=mobile,desktop,web --batch=5000 [--fresh] [--seed=42]';

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function positiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${name} must be a positive integer.\n${USAGE}`);
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values: args } = parseArgs({
    options: {
      keys: { type: 'string', default: '50000' },
      locales: { type: 'string', default: 'en,fr,es,de' },
      tags: { type: 'string', default: 'mobile,desktop,web' },
      batch: { type: 'string', default: '5000' },
      seed: { type: 'string', default: '42' },
      fresh: { type: 'boolean', default: false },
    },
  });
  const config = loadConfig(process.env);
  const db = createKysely(config.db, { applicationName: 'seeder' });
  const redis = createRedis(config.redis);

  try {
    await migrateToLatest(db);
    const admin = await provisionAdmin(new KyselyUserRepository(db), new Argon2PasswordHasher(), {
      email: config.auth.adminEmail,
      password: config.auth.adminPassword,
    });
    process.stdout.write(
      admin
        ? `Admin user ready: ${admin}\n`
        : 'ADMIN_EMAIL/ADMIN_PASSWORD not set; no admin provisioned.\n',
    );

    const changeLog = new KyselyCatalogChangeLog(db);
    const versions = new RedisVersionStore(redis, changeLog);
    const result = await new Seeder(db).run(
      {
        keys: positiveInt('keys', args.keys),
        locales: list(args.locales),
        tags: list(args.tags),
        batchSize: positiveInt('batch', args.batch),
        seed: positiveInt('seed', args.seed),
        fresh: args.fresh,
      },
      {
        onProgress: ({ keysWritten, totalKeys }) =>
          process.stdout.write(`\r  keys ${keysWritten}/${totalKeys}`),
        // Exports must reflect the new data: record a catalog change, then publish it.
        afterSeed: async () => {
          await versions.publish(await changeLog.record(db));
        },
      },
    );
    const seconds = (result.elapsedMs / MS_PER_SECOND).toFixed(1);
    process.stdout.write(
      `\nSeeded ${result.keys} keys / ${result.translations} translations in ${seconds}s\n`,
    );
  } finally {
    await db.destroy();
    await redis.quit();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seeding failed: ${String(error)}\n`);
  process.exitCode = 1;
});
