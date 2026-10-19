import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../../src/app.factory';
import { Argon2PasswordHasher } from '../../src/auth/password-hasher';
import { KyselyUserRepository } from '../../src/auth/repositories/user.repository';
import { ALL_TOKEN_SCOPES, type TokenScope } from '../../src/auth/token-scope';
import { PublishingCatalogNotifier } from '../../src/catalog-events/catalog-change-notifier';
import type { AppConfig } from '../../src/config/app-config';
import { type Database, createKysely } from '../../src/database/kysely.factory';
import { QueryCounter } from './query-counter';
import { testConfig } from './test-config';

export const ADMIN_EMAIL = 'admin@test.local';
export const ADMIN_PASSWORD = 'test-admin-password-123';

export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly config: AppConfig;
  /** Separate connection for fixtures and assertions. */
  readonly db: Database;
  readonly redis: Redis;
  readonly queries: QueryCounter;
  http(): TestAgent;
  /** Issues a real token through the API. */
  token(scopes?: readonly TokenScope[]): Promise<string>;
  /** Waits for background post-commit work (CDN purge, warming). */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** Empties catalog/auth tables and this suite's Redis keyspace. */
export async function resetState(db: Database, redis: Redis): Promise<void> {
  await sql`TRUNCATE translation_key_tags, translations, translation_keys, tags, locales, api_tokens, users RESTART IDENTITY CASCADE`.execute(
    db,
  );
  await redis.flushdb();
}

export async function seedLocales(
  db: Database,
  codes: readonly string[] = ['en', 'fr', 'es'],
): Promise<void> {
  await db
    .insertInto('locales')
    .values(codes.map((code) => ({ code, name: code.toUpperCase() })))
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}

/** Boots the real AppModule on Fastify against real Postgres and Redis. */
export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = testConfig(overrides);
  const queries = new QueryCounter();
  const db = createKysely(config.db, { applicationName: 'e2e-fixtures' });
  const redis = new Redis(config.redis.url);
  await resetState(db, redis);

  await new KyselyUserRepository(db).upsert({
    email: ADMIN_EMAIL,
    passwordHash: await new Argon2PasswordHasher().hash(ADMIN_PASSWORD),
    scopes: ALL_TOKEN_SCOPES,
  });
  await seedLocales(db);

  const app = await createApp(config, { kyselyPlugins: [queries] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const http = (): TestAgent => request(app.getHttpServer());
  return {
    app,
    config,
    db,
    redis,
    queries,
    http,
    async token(scopes = ALL_TOKEN_SCOPES) {
      const response = await http()
        .post('/api/v1/auth/tokens')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'e2e', scopes })
        .expect(201);
      return (response.body as { data: { token: string } }).data.token;
    },
    async settle() {
      await app.get(PublishingCatalogNotifier).drain();
    },
    async close() {
      await app.close();
      await db.destroy();
      await redis.quit();
    },
  };
}

export const bearer = (token: string): { Authorization: string } => ({
  Authorization: `Bearer ${token}`,
});
