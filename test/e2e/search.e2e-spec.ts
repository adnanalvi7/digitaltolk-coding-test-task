import { sql } from 'kysely';
import { createTranslationKey } from '../support/factories';
import { type TestApp, bearer, createTestApp } from '../support/test-app';

interface KeyBody {
  id: string;
  key: string;
  values: Record<string, string>;
  tags: string[];
}
interface Page {
  data: KeyBody[];
  meta: { nextCursor: string | null; limit: number };
}

describe('Search & pagination (e2e)', () => {
  let t: TestApp;
  let token: string;

  const list = async (query: Record<string, string | number>): Promise<Page> => {
    const response = await t
      .http()
      .get('/api/v1/translations')
      .query(query)
      .set(bearer(token))
      .expect(200);
    return response.body as Page;
  };
  const keysOf = (page: Page): string[] => page.data.map((item) => item.key).sort();

  beforeAll(async () => {
    t = await createTestApp();
    token = await t.token();
    await createTranslationKey(t.db, {
      key: 'checkout.button.pay',
      values: { en: 'Pay now', fr: 'Payer' },
      tags: ['web', 'mobile'],
    });
    await createTranslationKey(t.db, {
      key: 'checkout.button.cancel',
      values: { en: 'Cancel order', fr: 'Annuler' },
      tags: ['web'],
    });
    await createTranslationKey(t.db, {
      key: 'checkout_extra.note',
      values: { en: 'Underscore sibling' },
      tags: ['desktop'],
    });
    await createTranslationKey(t.db, {
      key: 'profile.title',
      values: { en: 'Your profile', fr: 'Votre profil' },
      tags: ['mobile'],
    });
    await createTranslationKey(t.db, {
      key: 'promo.banner',
      values: { en: 'Save 100% today_only' },
      tags: [],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('by key prefix', () => {
    it('matches keys starting with the prefix', async () => {
      expect(keysOf(await list({ key: 'checkout.' }))).toEqual([
        'checkout.button.cancel',
        'checkout.button.pay',
      ]);
    });

    it('treats _ literally (escaped), not as a single-char wildcard', async () => {
      expect(keysOf(await list({ key: 'checkout_' }))).toEqual(['checkout_extra.note']);
      expect(keysOf(await list({ key: 'checkout' }))).toHaveLength(3);
    });
  });

  describe('by content', () => {
    it('matches whole words via full-text search', async () => {
      expect(keysOf(await list({ q: 'cancel' }))).toEqual(['checkout.button.cancel']);
    });

    it('matches substrings via the trigram index', async () => {
      expect(keysOf(await list({ q: 'rofil' }))).toEqual(['profile.title']);
    });

    it('treats % and _ in the query literally', async () => {
      expect(keysOf(await list({ q: '100%' }))).toEqual(['promo.banner']);
      expect(keysOf(await list({ q: 'y_o' }))).toEqual(['promo.banner']);
    });

    it('restricts content matching and returned values to one locale', async () => {
      const page = await list({ q: 'payer', locale: 'FR' });
      expect(keysOf(page)).toEqual(['checkout.button.pay']);
      expect(page.data[0]?.values).toEqual({ fr: 'Payer' });
      expect(keysOf(await list({ q: 'payer', locale: 'en' }))).toEqual([]);
    });

    it('returns nothing for an unknown locale filter', async () => {
      expect((await list({ q: 'pay', locale: 'de' })).data).toEqual([]);
    });
  });

  describe('by tags', () => {
    it('matches any of the tags by default', async () => {
      expect(keysOf(await list({ tags: 'mobile,desktop' }))).toEqual([
        'checkout.button.pay',
        'checkout_extra.note',
        'profile.title',
      ]);
    });

    it('matches all tags with tagsMode=all', async () => {
      expect(keysOf(await list({ tags: 'web,mobile', tagsMode: 'all' }))).toEqual([
        'checkout.button.pay',
      ]);
    });

    it('treats unknown tags as matching nothing (all mode)', async () => {
      expect((await list({ tags: 'web,unknown', tagsMode: 'all' })).data).toEqual([]);
    });

    it('combines filters', async () => {
      expect(keysOf(await list({ key: 'checkout.', tags: 'mobile', q: 'pay' }))).toEqual([
        'checkout.button.pay',
      ]);
    });
  });

  describe('keyset pagination', () => {
    it('walks every page exactly once using opaque cursors', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page = await list(cursor ? { limit: 2, cursor } : { limit: 2 });
        seen.push(...page.data.map((item) => item.id));
        expect(page.meta.limit).toBe(2);
        cursor = page.meta.nextCursor;
        pages += 1;
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort((a, b) => Number(a) - Number(b))).toEqual(seen);
    });

    it('defaults to 50 per page with a null cursor on the last page', async () => {
      const page = await list({});
      expect(page.meta).toEqual({ nextCursor: null, limit: 50 });
    });

    it.each([
      ['tampered cursor', { cursor: 'eyJ2IjoyfQ' }],
      ['limit > 100', { limit: 101 }],
      ['limit 0', { limit: 0 }],
      ['short q', { q: 'a' }],
      ['bad tagsMode', { tagsMode: 'most' }],
      ['unknown query param', { sort: 'key' }],
    ])('422s on %s', async (_label, query) => {
      await t.http().get('/api/v1/translations').query(query).set(bearer(token)).expect(422);
    });

    it('401s without a token', async () => {
      await t.http().get('/api/v1/translations').expect(401);
    });
  });

  describe('content search across the probe window (adaptive plan)', () => {
    it('finds sparse matches beyond the probe window and pages through them in id order', async () => {
      // 2,500 keys; "needle" only at the 10th and the 2,400th — sparse, so the
      // bounded probe cannot fill a page and the index-first path must take over.
      await sql`
        WITH keys AS (
          INSERT INTO translation_keys (key)
          SELECT 'window.item_' || n FROM generate_series(1, 2500) AS n
          RETURNING id, key
        )
        INSERT INTO translations (translation_key_id, locale_id, value)
        SELECT k.id, (SELECT id FROM locales WHERE code = 'en'),
               CASE WHEN k.key IN ('window.item_10', 'window.item_2400') THEN 'a needle here' ELSE 'hay' END
        FROM keys k
      `.execute(t.db);

      const first = await list({ q: 'needle', limit: 1 });
      expect(first.data.map((item) => item.key)).toEqual(['window.item_10']);
      expect(first.meta.nextCursor).not.toBeNull();

      const second = await list({ q: 'needle', limit: 1, cursor: first.meta.nextCursor ?? '' });
      expect(second.data.map((item) => item.key)).toEqual(['window.item_2400']);
      expect(second.meta.nextCursor).toBeNull();

      expect((await list({ q: 'zqxjkv' })).data).toEqual([]);
      expect((await list({ q: 'hay', limit: 3 })).data).toHaveLength(3); // dense: served by the probe
    });

    it('finds sparse tag matches beyond the probe window in any and all modes', async () => {
      await sql`
        WITH t AS (
          INSERT INTO tags (name) VALUES ('sparse-a'), ('sparse-b') RETURNING id, name
        )
        INSERT INTO translation_key_tags (translation_key_id, tag_id)
        SELECT k.id, t.id FROM translation_keys k, t
        WHERE k.key = 'window.item_2450' OR (k.key = 'window.item_2460' AND t.name = 'sparse-a')
      `.execute(t.db);

      const any = await list({ tags: 'sparse-a', limit: 1 });
      expect(any.data.map((item) => item.key)).toEqual(['window.item_2450']);
      const next = await list({ tags: 'sparse-a', limit: 1, cursor: any.meta.nextCursor ?? '' });
      expect(next.data.map((item) => item.key)).toEqual(['window.item_2460']);

      const all = await list({ tags: 'sparse-a,sparse-b', tagsMode: 'all' });
      expect(all.data.map((item) => item.key)).toEqual(['window.item_2450']);
      expect(all.data[0]?.tags).toEqual(['sparse-a', 'sparse-b']);
    });
  });

  describe('N+1 guard', () => {
    it('loads a page of 100 keys with values and tags in a single statement', async () => {
      for (let i = 0; i < 100; i += 1) {
        await createTranslationKey(t.db, {
          key: `bulk.item_${i}`,
          values: { en: `E${i}`, fr: `F${i}`, es: `S${i}` },
          tags: ['bulk', i % 2 ? 'odd' : 'even'],
        });
      }
      await list({ limit: 1 }); // warm-up: token last_used_at write happens here

      t.queries.reset();
      const page = await list({ key: 'bulk.', limit: 100 });
      expect(page.data).toHaveLength(100);
      expect(
        page.data.every((item) => Object.keys(item.values).length === 3 && item.tags.length === 2),
      ).toBe(true);
      // Excludes auth and the background version reconciler (catalog_changes).
      expect(t.queries.statements({ excludingTables: ['api_tokens', 'catalog_changes'] })).toEqual([
        expect.stringMatching(/^SelectQueryNode: .*translation_keys/),
      ]);
    });
  });
});
