import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { KyselyCatalogChangeLog } from '../../src/catalog-events/catalog-change-log';
import { CATALOG_VERSION_KEY, RedisVersionStore } from '../../src/catalog-events/version-store';
import { type Database, createKysely } from '../../src/database/kysely.factory';
import {
  MigrationFailedError,
  createMigrator,
  migrateDown,
  migrateToLatest,
} from '../../src/database/migrations';
import { Seeder } from '../../src/seeding/seeder';
import { KyselyTagRepository } from '../../src/tags/tag.repository';
import { resetState } from '../support/test-app';
import { testConfig } from '../support/test-config';

describe('Database tooling (e2e)', () => {
  let db: Database;
  let redis: Redis;

  beforeAll(async () => {
    const config = testConfig();
    db = createKysely(config.db);
    redis = new Redis(config.redis.url, { keyPrefix: config.redis.keyPrefix });
    await resetState(db, redis);
  });
  afterAll(async () => {
    await migrateToLatest(db);
    await db.destroy();
    await redis.quit();
  });

  describe('migrations', () => {
    it('every migration rolls back cleanly and re-applies', async () => {
      for (let i = 0; i < 4; i += 1) await migrateDown(db);
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('translations', 'users', 'api_tokens', 'locales')
      `.execute(db);
      expect(rows[0]?.n).toBe(0);

      const { results = [] } = await migrateToLatest(db);
      expect(results.map((r) => `${r.migrationName}:${r.status}`)).toEqual([
        '0001_catalog:Success',
        '0002_auth:Success',
        '0003_catalog_changes:Success',
        '0004_widen_tag_ids:Success',
      ]);
      expect((await createMigrator(db).getMigrations()).every((m) => m.executedAt)).toBe(true);
    });

    it('surfaces a failing migration as MigrationFailedError (and the run is transactional)', async () => {
      await migrateDown(db); // 0004
      await migrateDown(db); // 0003
      await migrateDown(db); // 0002
      await sql`CREATE TABLE users (conflicting int)`.execute(db);
      try {
        await expect(migrateToLatest(db)).rejects.toThrow(MigrationFailedError);
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'api_tokens'
        `.execute(db);
        expect(rows[0]?.n).toBe(0);
      } finally {
        await sql`DROP TABLE users`.execute(db);
        await migrateToLatest(db);
      }
    });
  });

  describe('RedisVersionStore (Postgres-backed)', () => {
    it('publishes monotonically and restores the version from Postgres after Redis data loss', async () => {
      const changeLog = new KyselyCatalogChangeLog(db);
      const versions = new RedisVersionStore(redis, changeLog);
      const first = await changeLog.record(db);
      const second = await changeLog.record(db);
      expect(second).toBeGreaterThan(first);

      await versions.publish(second);
      await versions.publish(first); // out-of-order publisher: must not go backwards
      expect(await versions.current()).toBe(second);

      await redis.del(CATALOG_VERSION_KEY); // simulated Redis data loss
      expect(await versions.current()).toBe(second);
      expect(await changeLog.latest()).toBe(second);

      for (let i = 0; i < 5; i += 1) await changeLog.record(db);
      await changeLog.prune(2);
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM catalog_changes`.execute(db);
      expect(rows[0]?.n).toBe(3);
      expect(await changeLog.latest()).toBe(second + 5);
    });
  });

  describe('TagRepository.ensure', () => {
    it('does not consume identity values for tags that already exist', async () => {
      const tags = new KyselyTagRepository(db);
      const first = await tags.ensure(db, ['seq-a', 'seq-b']);
      const sequence = async () =>
        Number(
          (await sql<{ v: string }>`SELECT last_value::text AS v FROM tags_id_seq`.execute(db))
            .rows[0]?.v,
        );
      const before = await sequence();
      for (let i = 0; i < 50; i += 1) {
        expect((await tags.ensure(db, ['seq-a', 'seq-b'])).sort()).toEqual([...first].sort());
      }
      expect(await sequence()).toBe(before);
      const [created] = await tags.ensure(db, ['seq-c']);
      expect(created).toBeGreaterThan(before);
    });
  });

  describe('Seeder', () => {
    const options = {
      keys: 120,
      locales: ['en', 'fr', 'xx'],
      tags: ['web', 'mobile'],
      batchSize: 50,
      seed: 7,
      fresh: false,
    };

    it('bulk-loads keys × locales in batches, reports progress and bumps the version', async () => {
      const progress: number[] = [];
      const changeLog = new KyselyCatalogChangeLog(db);
      const versions = new RedisVersionStore(redis, changeLog);
      const before = await versions.current();

      const result = await new Seeder(db).run(options, {
        onProgress: ({ keysWritten }) => progress.push(keysWritten),
        afterSeed: async () => {
          await versions.publish(await changeLog.record(db));
        },
      });

      expect(result).toMatchObject({ keys: 120, translations: 360 });
      expect(progress).toEqual([50, 100, 120]);
      expect(await versions.current()).toBeGreaterThan(before);
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM translations`.execute(db);
      expect(rows[0]?.n).toBe(360);
      const tagged = await sql<{
        n: number;
      }>`SELECT count(DISTINCT translation_key_id)::int AS n FROM translation_key_tags`.execute(db);
      expect(tagged.rows[0]?.n).toBe(120);
    });

    it('is idempotent and deterministic', async () => {
      const snapshot = () =>
        sql<{ key: string; value: string }>`
          SELECT tk.key, t.value FROM translations t JOIN translation_keys tk ON tk.id = t.translation_key_id
          ORDER BY tk.key, t.locale_id
        `.execute(db);
      const first = (await snapshot()).rows;
      await new Seeder(db).run(options);
      expect((await snapshot()).rows).toEqual(first);
    });

    it('--fresh truncates, drops and rebuilds the GIN indexes', async () => {
      await new Seeder(db).run({ ...options, keys: 10, fresh: true });
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM translation_keys`.execute(db);
      expect(rows[0]?.n).toBe(10);
      const indexes = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'translations' ORDER BY indexname
      `.execute(db);
      expect(indexes.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(['translations_search_vector_idx', 'translations_value_trgm_idx']),
      );
    });

    it('works without tags', async () => {
      const result = await new Seeder(db).run({ ...options, keys: 5, tags: [], fresh: true });
      expect(result.translations).toBe(15);
    });
  });
});
