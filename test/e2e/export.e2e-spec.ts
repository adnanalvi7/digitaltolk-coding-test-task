import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { sql } from 'kysely';
import type { Response } from 'supertest';
import { TokenScope } from '../../src/auth/token-scope';
import { CATALOG_VERSION_KEY } from '../../src/catalog-events/version-store';
import { createTranslationKey } from '../support/factories';
import { type TestApp, bearer, createTestApp } from '../support/test-app';

const VERSION_KEY = `tms-test:${CATALOG_VERSION_KEY}`;

const GZIP_MAGIC = [0x1f, 0x8b];

/** superagent may or may not have inflated the body already; detect by magic bytes. */
function rawBody(response: Response): string {
  const body = response.body as unknown;
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(response.text, 'utf8');
  const gzipped = buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1];
  return (gzipped ? gunzipSync(buffer) : buffer).toString('utf8');
}

const binary = (res: Response, callback: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
};

describe('Export (e2e)', () => {
  describe('private mode (default)', () => {
    let t: TestApp;
    let token: string;
    let writer: string;

    const exportLocale = (path: string, headers: Record<string, string> = {}) =>
      t
        .http()
        .get(`/api/v1/export/${path}`)
        .set(bearer(token))
        .set(headers)
        .buffer(true)
        .parse(binary);

    const json = async (path: string): Promise<{ body: unknown; etag: string }> => {
      const response = await exportLocale(path, { 'Accept-Encoding': 'gzip' }).expect(200);
      return {
        body: JSON.parse(rawBody(response)) as unknown,
        etag: String(response.headers.etag),
      };
    };

    const version = async (): Promise<number> => Number((await t.redis.get(VERSION_KEY)) ?? 0);

    beforeAll(async () => {
      t = await createTestApp();
      token = await t.token([TokenScope.ExportRead]);
      writer = await t.token();
      await createTranslationKey(t.db, {
        key: 'home.title',
        values: { en: 'Home', fr: 'Accueil' },
        tags: ['web'],
      });
      await createTranslationKey(t.db, {
        key: 'home.cta.start',
        values: { en: 'Start' },
        tags: ['mobile'],
      });
    });
    afterAll(async () => {
      await t.close();
    });

    it('exports a locale as flat JSON with private caching headers', async () => {
      const response = await exportLocale('en', { 'Accept-Encoding': 'gzip' }).expect(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers.vary).toContain('Accept-Encoding, Authorization');
      expect(response.headers.etag).toMatch(/^W\/"/);
      expect(JSON.parse(rawBody(response))).toEqual({
        'home.cta.start': 'Start',
        'home.title': 'Home',
      });
    });

    it('serves identity encoding to clients that do not accept gzip', async () => {
      const response = await exportLocale('en', { 'Accept-Encoding': 'identity' }).expect(200);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(rawBody(response))).toEqual({
        'home.cta.start': 'Start',
        'home.title': 'Home',
      });
    });

    it('exports the nested format and filters by tags', async () => {
      expect((await json('en?format=nested')).body).toEqual({
        home: { cta: { start: 'Start' }, title: 'Home' },
      });
      expect((await json('en?tags=web')).body).toEqual({ 'home.title': 'Home' });
      expect((await json('fr')).body).toEqual({ 'home.title': 'Accueil' });
    });

    it('answers 304 on a matching If-None-Match', async () => {
      const { etag } = await json('en');
      const response = await exportLocale('en', { 'If-None-Match': etag }).expect(304);
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it('is fresh immediately after an update: new value and a new ETag', async () => {
      const before = await json('en');
      const created = await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(writer))
        .send({ key: 'fresh.key', values: { en: 'v1' } })
        .expect(201);
      const id = (created.body as { data: { id: string } }).data.id;
      const afterCreate = await json('en');
      expect(afterCreate.etag).not.toBe(before.etag);
      expect(afterCreate.body).toMatchObject({ 'fresh.key': 'v1' });

      await t
        .http()
        .patch(`/api/v1/translations/${id}`)
        .set(bearer(writer))
        .send({ values: { en: 'v2' } })
        .expect(200);
      const afterUpdate = await json('en');
      expect(afterUpdate.etag).not.toBe(afterCreate.etag);
      expect(afterUpdate.body).toMatchObject({ 'fresh.key': 'v2' });
      await exportLocale('en', { 'If-None-Match': afterCreate.etag }).expect(200);

      await t.http().delete(`/api/v1/translations/${id}`).set(bearer(writer)).expect(204);
      expect((await json('en')).body).not.toHaveProperty('fresh.key');
    });

    it('is fresh after locale changes: a deactivated locale 404s immediately', async () => {
      await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(writer))
        .send({ code: 'it', name: 'Italiano' })
        .expect(201);
      await json('it');
      await t
        .http()
        .patch('/api/v1/locales/it')
        .set(bearer(writer))
        .send({ isActive: false })
        .expect(200);
      await exportLocale('it').expect(404);
    });

    it('never bumps the version when the write transaction rolls back', async () => {
      await sql`
        CREATE OR REPLACE FUNCTION fail_tag_link() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced failure for rollback test'; END $$
      `.execute(t.db);
      await sql`CREATE TRIGGER fail_tag_link BEFORE INSERT ON translation_key_tags FOR EACH ROW EXECUTE FUNCTION fail_tag_link()`.execute(
        t.db,
      );
      try {
        const before = await version();
        const { etag } = await json('en');
        await t
          .http()
          .post('/api/v1/translations')
          .set(bearer(writer))
          .send({ key: 'rolled.back', values: { en: 'ghost' }, tags: ['web'] })
          .expect(500);
        expect(await version()).toBe(before);
        const row = await t.db
          .selectFrom('translation_keys')
          .select('id')
          .where('key', '=', 'rolled.back')
          .executeTakeFirst();
        expect(row).toBeUndefined();
        await exportLocale('en', { 'If-None-Match': etag }).expect(304);
      } finally {
        await sql`DROP TRIGGER IF EXISTS fail_tag_link ON translation_key_tags`.execute(t.db);
        await sql`DROP FUNCTION IF EXISTS fail_tag_link()`.execute(t.db);
      }
    });

    it('does not bump the version on a rejected duplicate (409)', async () => {
      const before = await version();
      await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(writer))
        .send({ key: 'home.title', values: { en: 'x' } })
        .expect(409);
      expect(await version()).toBe(before);
    });

    it('caches the compressed document in Redis under a versioned key', async () => {
      await json('en');
      const keys = await t.redis.keys('tms-test:export:en:flat:all:v*');
      expect(keys).toContain(`tms-test:export:en:flat:all:v${await version()}`);
    });

    it('404s for unknown locales and 422s for malformed ones or bad query params', async () => {
      await exportLocale('zz').expect(404);
      await exportLocale('not_a_locale').expect(422);
      await exportLocale('en?format=yaml').expect(422);
      await exportLocale('en?tags=NOT%20OK').expect(422);
    });

    it('requires a token with export:read', async () => {
      await t.http().get('/api/v1/export/en').expect(401);
      const readOnly = await t.token([TokenScope.TranslationsRead]);
      await t.http().get('/api/v1/export/en').set(bearer(readOnly)).expect(403);
    });
  });

  describe('self-healing freshness', () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await createTestApp({ CATALOG_RECONCILE_INTERVAL_MS: '100' });
    });
    afterAll(async () => {
      await t.close();
    });

    it('recovers from a lost post-commit publish within one reconcile interval', async () => {
      const token = await t.token();
      const exportEn = async (): Promise<unknown> => {
        const response = await t
          .http()
          .get('/api/v1/export/en')
          .set(bearer(token))
          .set('Accept-Encoding', 'identity')
          .expect(200);
        return response.body;
      };
      await exportEn(); // cache the current version

      const stale = await t.redis.get(VERSION_KEY);
      await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(token))
        .send({ key: 'healed.key', values: { en: 'Healed' } })
        .expect(201);
      // Simulate the publish having failed: Redis still holds the old version.
      await t.redis.set(VERSION_KEY, stale ?? '0');
      expect(await exportEn()).not.toHaveProperty(['healed.key']);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await exportEn()).toMatchObject({ 'healed.key': 'Healed' });
    });

    it('repairs a cached version ahead of Postgres (old key layout / DB restore) instead of freezing', async () => {
      const token = await t.token();
      const exportEn = async (): Promise<unknown> =>
        (
          await t
            .http()
            .get('/api/v1/export/en')
            .set(bearer(token))
            .set('Accept-Encoding', 'identity')
            .expect(200)
        ).body;

      // e.g. an epoch-based value left by an older versioning scheme.
      await t.redis.set(VERSION_KEY, '1792000000000000');
      await exportEn();
      await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(token))
        .send({ key: 'unfrozen.key', values: { en: 'Unfrozen' } })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(Number(await t.redis.get(VERSION_KEY))).toBeLessThan(1792000000000000);
      expect(await exportEn()).toMatchObject({ 'unfrozen.key': 'Unfrozen' });
    });
  });

  describe('public CDN mode', () => {
    let t: TestApp;
    let purgeServer: Server;
    const purges: unknown[] = [];

    beforeAll(async () => {
      purgeServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          purges.push({ auth: req.headers.authorization, body: JSON.parse(body) as unknown });
          res.writeHead(200).end('{}');
        });
      });
      await new Promise<void>((resolve) => purgeServer.listen(0, '127.0.0.1', resolve));
      const { port } = purgeServer.address() as AddressInfo;
      t = await createTestApp({
        EXPORT_PUBLIC: 'true',
        EXPORT_S_MAXAGE_SECONDS: '120',
        EXPORT_STALE_WHILE_REVALIDATE_SECONDS: '15',
        EXPORT_WARM_ON_CHANGE: 'true',
        CDN_PURGE_URL: `http://127.0.0.1:${port}/purge`,
        CDN_PURGE_TOKEN: 'cdn-secret',
        CDN_PUBLIC_BASE_URL: 'https://cdn.example.com',
      });
      await createTranslationKey(t.db, { key: 'public.title', values: { en: 'Public' } });
    });
    afterAll(async () => {
      await t.close();
      await new Promise<void>((resolve) =>
        purgeServer.close(() => {
          resolve();
        }),
      );
    });

    it('serves the export without a token, with CDN-cacheable headers', async () => {
      const response = await t.http().get('/api/v1/export/en').expect(200);
      expect(response.headers['cache-control']).toBe(
        'public, max-age=0, s-maxage=120, stale-while-revalidate=15, must-revalidate',
      );
      expect(response.headers.vary).not.toContain('Authorization');
      expect(response.headers.etag).toMatch(/^W\//);
    });

    it('purges the CDN and pre-warms exports after a committed write', async () => {
      const writer = await t.token();
      await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(writer))
        .send({ key: 'public.new', values: { en: 'New' } })
        .expect(201);
      await t.settle();

      expect(purges).toContainEqual({
        auth: 'Bearer cdn-secret',
        body: { prefixes: ['https://cdn.example.com/api/v1/export/'] },
      });
      const version = Number(await t.redis.get(VERSION_KEY));
      expect(await t.redis.exists(`tms-test:export:en:flat:all:v${version}`)).toBe(1);
      expect(await t.redis.exists(`tms-test:export:en:nested:all:v${version}`)).toBe(1);
    });
  });
});
