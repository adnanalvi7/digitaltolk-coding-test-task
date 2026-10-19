import { generateToken, hashToken } from '../../src/auth/token-crypto';
import { TokenScope } from '../../src/auth/token-scope';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type TestApp,
  bearer,
  createTestApp,
} from '../support/test-app';

describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /auth/tokens', () => {
    it('issues a token once, storing only its hash', async () => {
      const response = await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          name: 'ci',
          scopes: ['translations:read'],
          ttlSeconds: 120,
        })
        .expect(201);

      const body = response.body as {
        data: { token: string; scopes: string[]; expiresAt: string };
      };
      expect(body.data.token).toMatch(/^tms_[\w-]{43}$/);
      expect(body.data.scopes).toEqual(['translations:read']);
      const row = await t.db
        .selectFrom('api_tokens')
        .select(['token_hash', 'expires_at'])
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBe(hashToken(body.data.token));
      expect(JSON.stringify(row)).not.toContain(body.data.token);
    });

    it('matches emails case-insensitively (citext)', async () => {
      await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD, name: 'ci' })
        .expect(201);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      const wrong = await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({ email: ADMIN_EMAIL, password: 'nope', name: 'x' })
        .expect(401);
      const unknown = await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({ email: 'ghost@test.local', password: 'nope', name: 'x' })
        .expect(401);
      expect((wrong.body as { detail: string }).detail).toBe(
        (unknown.body as { detail: string }).detail,
      );
      expect(wrong.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(wrong.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it.each([
      ['missing email', { password: 'x', name: 'x' }, 'email'],
      ['invalid email', { email: 'nope', password: 'x', name: 'x' }, 'email'],
      [
        'unknown scope',
        { email: ADMIN_EMAIL, password: 'x', name: 'x', scopes: ['root'] },
        'scopes',
      ],
      [
        'ttl too short',
        { email: ADMIN_EMAIL, password: 'x', name: 'x', ttlSeconds: 1 },
        'ttlSeconds',
      ],
      ['unknown field', { email: ADMIN_EMAIL, password: 'x', name: 'x', isAdmin: true }, 'isAdmin'],
    ])('rejects %s with 422', async (_label, body, field) => {
      const response = await t.http().post('/api/v1/auth/tokens').send(body).expect(422);
      const problem = response.body as { errors: { field: string }[] };
      expect(problem.errors.map((e) => e.field)).toContain(field);
    });

    it('422s a TTL above the configured maximum', async () => {
      await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'x', ttlSeconds: 999_999_999 })
        .expect(422);
    });

    it('403s when requesting scopes the user cannot grant', async () => {
      await t.db
        .updateTable('users')
        .set({ scopes: ['translations:read'] })
        .execute();
      await t
        .http()
        .post('/api/v1/auth/tokens')
        .send({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          name: 'x',
          scopes: ['locales:write'],
        })
        .expect(403);
      await t.db
        .updateTable('users')
        .set({ scopes: Object.values(TokenScope) })
        .execute();
    });
  });

  describe('bearer authentication', () => {
    const protectedRoute = '/api/v1/locales';

    it('401s without a token, with a Bearer challenge', async () => {
      const response = await t.http().get(protectedRoute).expect(401);
      expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it.each([
      ['a malformed token', 'Bearer not-a-token'],
      ['a well-formed but unknown token', `Bearer ${generateToken().plaintext}`],
      ['a non-Bearer scheme', 'Basic YWRtaW46cGFzcw=='],
    ])('401s with %s', async (_label, header) => {
      await t.http().get(protectedRoute).set('Authorization', header).expect(401);
    });

    it('401s with an expired token', async () => {
      const token = await t.token();
      await t.db
        .updateTable('api_tokens')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', hashToken(token))
        .execute();
      await t.http().get(protectedRoute).set(bearer(token)).expect(401);
    });

    it('401s after revocation via DELETE /auth/tokens/current', async () => {
      const token = await t.token();
      await t.http().get(protectedRoute).set(bearer(token)).expect(200);
      await t.http().delete('/api/v1/auth/tokens/current').set(bearer(token)).expect(204);
      await t.http().get(protectedRoute).set(bearer(token)).expect(401);
    });

    it('401s on DELETE /auth/tokens/current without a token', async () => {
      await t.http().delete('/api/v1/auth/tokens/current').expect(401);
    });

    it('403s when the token lacks the required scope', async () => {
      const readOnly = await t.token([TokenScope.ExportRead]);
      const response = await t.http().get(protectedRoute).set(bearer(readOnly)).expect(403);
      expect((response.body as { detail: string }).detail).toContain('translations:read');
    });

    it('records last_used_at at most once per interval', async () => {
      const token = await t.token();
      const read = () =>
        t.db
          .selectFrom('api_tokens')
          .select('last_used_at')
          .where('token_hash', '=', hashToken(token))
          .executeTakeFirstOrThrow();
      expect((await read()).last_used_at).toBeNull();
      await t.http().get(protectedRoute).set(bearer(token)).expect(200);
      const first = (await read()).last_used_at;
      expect(first).not.toBeNull();
      await t.http().get(protectedRoute).set(bearer(token)).expect(200);
      expect((await read()).last_used_at).toEqual(first);
    });
  });
});
