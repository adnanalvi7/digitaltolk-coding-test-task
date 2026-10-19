import { TokenScope } from '../../src/auth/token-scope';
import { type TestApp, bearer, createTestApp } from '../support/test-app';

interface KeyBody {
  id: string;
  key: string;
  description: string | null;
  values: Record<string, string>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
interface Problem {
  status: number;
  errors?: { field: string; message: string }[];
  detail: string;
}

describe('Translations CRUD (e2e)', () => {
  let t: TestApp;
  let writer: string;
  let reader: string;

  beforeAll(async () => {
    t = await createTestApp();
    writer = await t.token();
    reader = await t.token([TokenScope.TranslationsRead]);
  });
  afterAll(async () => {
    await t.close();
  });

  const create = (body: object, token = writer) =>
    t.http().post('/api/v1/translations').set(bearer(token)).send(body);

  describe('POST /translations', () => {
    it('creates a key with values and deduplicated tags (201 + Location)', async () => {
      const response = await create({
        key: 'checkout.button.pay',
        description: 'Primary CTA',
        values: { en: 'Pay now', fr: 'Payer maintenant' },
        tags: ['web', 'mobile', 'web'],
      }).expect(201);

      const body = (response.body as { data: KeyBody }).data;
      expect(response.headers.location).toBe(`/api/v1/translations/${body.id}`);
      expect(body).toMatchObject({
        key: 'checkout.button.pay',
        description: 'Primary CTA',
        values: { en: 'Pay now', fr: 'Payer maintenant' },
        tags: ['mobile', 'web'],
      });
      expect(typeof body.id).toBe('string');
    });

    it('409s on a duplicate key, leaving no partial data behind', async () => {
      await create({ key: 'dup.key', values: { en: 'One' } }).expect(201);
      const response = await create({
        key: 'dup.key',
        values: { en: 'Two' },
        tags: ['new-tag'],
      }).expect(409);
      expect((response.body as Problem).detail).toContain('dup.key');
      const tags = await t.db
        .selectFrom('tags')
        .select('name')
        .where('name', '=', 'new-tag')
        .execute();
      expect(tags).toEqual([]);
    });

    it.each([
      ['missing key', { values: { en: 'x' } }, 'key'],
      ['invalid key', { key: 'Bad Key', values: { en: 'x' } }, 'key'],
      ['key too long', { key: 'a'.repeat(192), values: { en: 'x' } }, 'key'],
      ['missing values', { key: 'a.b' }, 'values'],
      ['empty values', { key: 'a.b', values: {} }, 'values'],
      ['unknown locale', { key: 'a.b', values: { zz: 'x' } }, 'values'],
      ['non-string value', { key: 'a.b', values: { en: 1 } }, 'values'],
      ['oversized value', { key: 'a.b', values: { en: 'x'.repeat(65_536) } }, 'values'],
      ['invalid tag', { key: 'a.b', values: { en: 'x' }, tags: ['UPPER'] }, 'tags'],
      [
        'too many tags',
        { key: 'a.b', values: { en: 'x' }, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        'tags',
      ],
      [
        'long description',
        { key: 'a.b', values: { en: 'x' }, description: 'x'.repeat(501) },
        'description',
      ],
      ['unknown field', { key: 'a.b', values: { en: 'x' }, id: 5 }, 'id'],
    ])('422s on %s', async (_label, body, field) => {
      const response = await create(body).expect(422);
      const problem = response.body as Problem;
      expect(problem.errors?.map((e) => e.field)).toContain(field);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('401s without a token and 403s without translations:write', async () => {
      await t
        .http()
        .post('/api/v1/translations')
        .send({ key: 'a.b', values: { en: 'x' } })
        .expect(401);
      await create({ key: 'a.b', values: { en: 'x' } }, reader).expect(403);
    });
  });

  describe('GET /translations/:id', () => {
    it('shows a key with all values and tags', async () => {
      const created = (
        await create({ key: 'show.me', values: { en: 'Hi', es: 'Hola' }, tags: ['web'] }).expect(
          201,
        )
      ).body as { data: KeyBody };
      const response = await t
        .http()
        .get(`/api/v1/translations/${created.data.id}`)
        .set(bearer(reader))
        .expect(200);
      expect((response.body as { data: KeyBody }).data).toEqual(created.data);
    });

    it('404s with a generic, leak-free body', async () => {
      const response = await t
        .http()
        .get('/api/v1/translations/999999')
        .set(bearer(reader))
        .expect(404);
      expect((response.body as Problem).detail).toBe('The requested resource was not found.');
      expect(JSON.stringify(response.body)).not.toMatch(/translation_keys|select |stack/i);
    });

    it('422s on a non-numeric or out-of-range id', async () => {
      await t.http().get('/api/v1/translations/abc').set(bearer(reader)).expect(422);
      await t
        .http()
        .get('/api/v1/translations/99999999999999999999')
        .set(bearer(reader))
        .expect(422);
    });

    it('401s/403s', async () => {
      await t.http().get('/api/v1/translations/1').expect(401);
      const exportOnly = await t.token([TokenScope.ExportRead]);
      await t.http().get('/api/v1/translations/1').set(bearer(exportOnly)).expect(403);
    });
  });

  describe('PATCH /translations/:id', () => {
    let id: string;

    beforeEach(async () => {
      const created = await create({
        key: `patch.me_${Date.now()}`,
        description: 'old',
        values: { en: 'Hello', fr: 'Bonjour' },
        tags: ['web'],
      }).expect(201);
      id = (created.body as { data: KeyBody }).data.id;
    });

    const patch = (body: object, token = writer) =>
      t.http().patch(`/api/v1/translations/${id}`).set(bearer(token)).send(body);

    it('merges values by locale (upsert) and leaves other locales untouched', async () => {
      const response = await patch({ values: { en: 'Hello!', es: 'Hola' } }).expect(200);
      expect((response.body as { data: KeyBody }).data.values).toEqual({
        en: 'Hello!',
        es: 'Hola',
        fr: 'Bonjour',
      });
    });

    it('removes a locale value with null, clears the description, replaces tags', async () => {
      const response = await patch({
        values: { fr: null },
        description: null,
        tags: ['mobile', 'desktop'],
      }).expect(200);
      expect((response.body as { data: KeyBody }).data).toMatchObject({
        values: { en: 'Hello' },
        description: null,
        tags: ['desktop', 'mobile'],
      });
    });

    it('clears all tags with an empty array', async () => {
      const response = await patch({ tags: [] }).expect(200);
      expect((response.body as { data: KeyBody }).data.tags).toEqual([]);
    });

    it('bumps updatedAt', async () => {
      const before = (await t.http().get(`/api/v1/translations/${id}`).set(bearer(reader)))
        .body as { data: KeyBody };
      const after = (await patch({ description: 'new' }).expect(200)).body as { data: KeyBody };
      expect(new Date(after.data.updatedAt).getTime()).toBeGreaterThan(
        new Date(before.data.updatedAt).getTime(),
      );
    });

    it('rejects changing the immutable key and unknown locales (422)', async () => {
      await patch({ key: 'renamed' }).expect(422);
      await patch({ values: { zz: 'x' } }).expect(422);
    });

    it('404s for a missing key', async () => {
      await t
        .http()
        .patch('/api/v1/translations/999999')
        .set(bearer(writer))
        .send({ description: 'x' })
        .expect(404);
    });

    it('401s/403s', async () => {
      await t.http().patch(`/api/v1/translations/${id}`).send({ description: 'x' }).expect(401);
      await patch({ description: 'x' }, reader).expect(403);
    });
  });

  describe('DELETE /translations/:id', () => {
    it('deletes a key and its values (204), then 404s', async () => {
      const created = (
        await create({ key: 'delete.me', values: { en: 'Bye' }, tags: ['web'] }).expect(201)
      ).body as {
        data: KeyBody;
      };
      await t
        .http()
        .delete(`/api/v1/translations/${created.data.id}`)
        .set(bearer(writer))
        .expect(204);
      await t.http().get(`/api/v1/translations/${created.data.id}`).set(bearer(reader)).expect(404);
      await t
        .http()
        .delete(`/api/v1/translations/${created.data.id}`)
        .set(bearer(writer))
        .expect(404);
      const orphans = await t.db
        .selectFrom('translations')
        .select('id')
        .where('translation_key_id', '=', created.data.id)
        .execute();
      expect(orphans).toEqual([]);
    });

    it('401s/403s/422s', async () => {
      await t.http().delete('/api/v1/translations/1').expect(401);
      await t.http().delete('/api/v1/translations/1').set(bearer(reader)).expect(403);
      await t.http().delete('/api/v1/translations/x').set(bearer(writer)).expect(422);
    });
  });
});
