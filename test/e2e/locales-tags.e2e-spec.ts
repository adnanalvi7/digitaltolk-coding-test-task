import { TokenScope } from '../../src/auth/token-scope';
import { createTranslationKey } from '../support/factories';
import { type TestApp, bearer, createTestApp } from '../support/test-app';

interface LocaleBody {
  code: string;
  name: string;
  isActive: boolean;
}

describe('Locales & tags (e2e)', () => {
  let t: TestApp;
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.token();
    reader = await t.token([TokenScope.TranslationsRead]);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET /locales', () => {
    it('lists locales', async () => {
      const response = await t.http().get('/api/v1/locales').set(bearer(reader)).expect(200);
      const codes = (response.body as { data: LocaleBody[] }).data.map((l) => l.code);
      expect(codes).toEqual(['en', 'es', 'fr']);
    });

    it('401s without a token', async () => {
      await t.http().get('/api/v1/locales').expect(401);
    });
  });

  describe('POST /locales', () => {
    it('adds a language without any migration, canonicalising its code', async () => {
      const response = await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(admin))
        .send({ code: 'pt-br', name: 'Português (Brasil)' })
        .expect(201);
      expect(response.headers.location).toBe('/api/v1/locales/pt-BR');
      expect((response.body as { data: LocaleBody }).data).toMatchObject({
        code: 'pt-BR',
        isActive: true,
      });

      // Immediately usable for translations.
      await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(admin))
        .send({ key: 'new.locale.works', values: { 'pt-BR': 'Funciona' } })
        .expect(201);
    });

    it('409s on a duplicate code', async () => {
      await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(admin))
        .send({ code: 'en', name: 'Again' })
        .expect(409);
    });

    it.each([
      ['invalid code', { code: 'english', name: 'x' }, 'code'],
      ['missing name', { code: 'it' }, 'name'],
      ['long name', { code: 'it', name: 'x'.repeat(65) }, 'name'],
      ['non-boolean isActive', { code: 'it', name: 'x', isActive: 'yes' }, 'isActive'],
      ['unknown field', { code: 'it', name: 'x', id: 1 }, 'id'],
    ])('422s on %s', async (_label, body, field) => {
      const response = await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(admin))
        .send(body)
        .expect(422);
      expect(
        (response.body as { errors: { field: string }[] }).errors.map((e) => e.field),
      ).toContain(field);
    });

    it('403s without locales:write', async () => {
      await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(reader))
        .send({ code: 'it', name: 'Italiano' })
        .expect(403);
    });
  });

  describe('PATCH /locales/:code', () => {
    it('renames and deactivates; inactive locales are rejected on writes', async () => {
      await t
        .http()
        .post('/api/v1/locales')
        .set(bearer(admin))
        .send({ code: 'de', name: 'German' })
        .expect(201);
      const response = await t
        .http()
        .patch('/api/v1/locales/DE')
        .set(bearer(admin))
        .send({ name: 'Deutsch', isActive: false })
        .expect(200);
      expect((response.body as { data: LocaleBody }).data).toMatchObject({
        code: 'de',
        name: 'Deutsch',
        isActive: false,
      });

      const write = await t
        .http()
        .post('/api/v1/translations')
        .set(bearer(admin))
        .send({ key: 'inactive.locale', values: { de: 'Hallo' } })
        .expect(422);
      expect(JSON.stringify(write.body)).toContain('unknown or inactive locale');
    });

    it('404s for an unknown locale', async () => {
      await t
        .http()
        .patch('/api/v1/locales/zz')
        .set(bearer(admin))
        .send({ name: 'Nope' })
        .expect(404);
    });

    it('422s for a malformed code or body', async () => {
      await t
        .http()
        .patch('/api/v1/locales/not_a_code')
        .set(bearer(admin))
        .send({ name: 'x' })
        .expect(422);
      await t
        .http()
        .patch('/api/v1/locales/en')
        .set(bearer(admin))
        .send({ code: 'xx' })
        .expect(422);
    });

    it('403s without locales:write', async () => {
      await t
        .http()
        .patch('/api/v1/locales/en')
        .set(bearer(reader))
        .send({ name: 'x' })
        .expect(403);
    });
  });

  describe('GET /tags', () => {
    it('lists tags created implicitly by translation writes', async () => {
      await createTranslationKey(t.db, { tags: ['web', 'mobile'] });
      const response = await t.http().get('/api/v1/tags').set(bearer(reader)).expect(200);
      expect((response.body as { data: { name: string }[] }).data.map((tag) => tag.name)).toEqual([
        'mobile',
        'web',
      ]);
    });

    it('401s and 403s appropriately', async () => {
      await t.http().get('/api/v1/tags').expect(401);
      const exportOnly = await t.token([TokenScope.ExportRead]);
      await t.http().get('/api/v1/tags').set(bearer(exportOnly)).expect(403);
    });
  });
});
