import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { ADMIN_EMAIL, type TestApp, bearer, createTestApp } from '../support/test-app';

/**
 * Fastify rejects an oversized body from its Content-Length header alone and
 * may reset the socket while a client is still uploading, which made upload-
 * based assertions racy. This sends only the headers (declaring `bytes`),
 * waits for the response, then discards the request: deterministic.
 */
async function postDeclaringLength(
  t: TestApp,
  path: string,
  bytes: number,
  headers: Record<string, string>,
): Promise<{ status: number; payload: string }> {
  const server = t.app.getHttpServer() as { address(): AddressInfo | string | null };
  const tcpPort = (): number | undefined => {
    const address = server.address();
    return address !== null && typeof address !== 'string' ? address.port : undefined;
  };
  if (tcpPort() === undefined) await t.app.listen(0, '127.0.0.1');
  const port = tcpPort();
  if (port === undefined) throw new Error('test server has no TCP address');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { ...headers, 'content-length': bytes },
      },
      (res) => {
        let payload = '';
        res.on('data', (chunk: Buffer) => (payload += chunk.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, payload });
          req.destroy();
        });
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error);
    });
    req.flushHeaders();
  });
}

interface Problem {
  type: string;
  status: number;
  detail: string;
  requestId: string;
  instance: string;
}

describe('Security & HTTP hygiene (e2e)', () => {
  let t: TestApp;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp({ CORS_ORIGINS: 'https://app.example.com' });
    token = await t.token();
  });
  afterAll(async () => {
    await t.close();
  });

  const post = () => t.http().post('/api/v1/translations').set(bearer(token));

  it('413s on bodies over 1 MiB', async () => {
    const { status, payload } = await postDeclaringLength(t, '/api/v1/translations', 1_100_000, {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    });
    expect(status).toBe(413);
    expect((JSON.parse(payload) as Problem).type).toMatch(/payload-too-large$/);
  });

  it.each([
    ['text/plain', 'hello'],
    ['application/x-www-form-urlencoded', 'key=a&values=b'],
    ['application/xml', '<a/>'],
  ])('415s on %s bodies', async (contentType, body) => {
    const response = await post().set('Content-Type', contentType).send(body).expect(415);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('400s on malformed JSON', async () => {
    await post().set('Content-Type', 'application/json').send('{"key":').expect(400);
  });

  it('400s on prototype-poisoning payloads', async () => {
    await post()
      .set('Content-Type', 'application/json')
      .send('{"key":"a.b","values":{"en":"x"},"__proto__":{"isAdmin":true}}')
      .expect(400);
  });

  it('returns problem+json 404 for unknown routes', async () => {
    const response = await t.http().get('/api/v1/does-not-exist').set(bearer(token)).expect(404);
    expect(response.body as Problem).toMatchObject({
      status: 404,
      instance: '/api/v1/does-not-exist',
    });
  });

  it('returns a generic 500 that leaks nothing, with a request id', async () => {
    await sql`
      CREATE OR REPLACE FUNCTION explode() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'secret internal detail: relation xyz'; END $$
    `.execute(t.db);
    await sql`CREATE TRIGGER explode BEFORE INSERT ON translations FOR EACH ROW EXECUTE FUNCTION explode()`.execute(
      t.db,
    );
    try {
      const response = await post()
        .send({ key: 'boom.key', values: { en: 'x' } })
        .expect(500);
      const problem = response.body as Problem;
      expect(problem.detail).toBe('An unexpected error occurred.');
      expect(problem.requestId).toBe(response.headers['x-request-id']);
      expect(JSON.stringify(problem)).not.toMatch(/secret|relation|stack|explode/i);
    } finally {
      await sql`DROP TRIGGER IF EXISTS explode ON translations`.execute(t.db);
      await sql`DROP FUNCTION IF EXISTS explode()`.execute(t.db);
    }
  });

  describe('request ids', () => {
    it('echoes a valid incoming ULID and binds it to error bodies', async () => {
      const id = '01J9ZK3M5V7Q2X8Y4N6P0R1S2T';
      const response = await t.http().get('/api/v1/locales').set('X-Request-Id', id).expect(401);
      expect(response.headers['x-request-id']).toBe(id);
      expect((response.body as Problem).requestId).toBe(id);
    });

    it('replaces an invalid incoming id with a generated UUID', async () => {
      const response = await t
        .http()
        .get('/api/v1/health/live')
        .set('X-Request-Id', 'not valid')
        .expect(200);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('sets security headers (helmet)', async () => {
    const response = await t.http().get('/api/v1/health/live').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('restricts CORS to the configured allowlist', async () => {
    const allowed = await t
      .http()
      .options('/api/v1/locales')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await t
      .http()
      .options('/api/v1/locales')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never stores or returns password hashes', async () => {
    const response = await t.http().get('/api/v1/locales').set(bearer(token)).expect(200);
    expect(JSON.stringify(response.body)).not.toContain('argon2');
    const user = await t.db
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', ADMIN_EMAIL)
      .executeTakeFirstOrThrow();
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('Rate limiting (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      THROTTLE_AUTH_LIMIT: '2',
      THROTTLE_API_LIMIT: '3',
      THROTTLE_EXPORT_LIMIT: '2',
      THROTTLE_AUTH_FAILURE_LIMIT: '4',
    });
  });

  const randomToken = (): string => `tms_${randomBytes(32).toString('base64url')}`;

  it('blocks an IP flooding random tokens instead of giving each string a fresh budget', async () => {
    await t.redis.flushdb();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await t.http().get('/api/v1/locales').set(bearer(randomToken()))).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    const blocked = await t.http().get('/api/v1/locales').set(bearer(randomToken())).expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('caps password spraying across many emails from one IP', async () => {
    await t.redis.flushdb();
    const spray = (i: number) =>
      t
        .http()
        .post('/api/v1/auth/tokens')
        .send({ email: `user${i}@test.local`, password: 'Winter2026!', name: 'x' });
    for (let i = 0; i < 5; i += 1) await spray(i).expect(401);
    await spray(99).expect(429);
  });

  it('never counts successful authentications as failures', async () => {
    await t.redis.flushdb();
    const token = await t.token();
    for (let i = 0; i < 2; i += 1) {
      await t.http().get('/api/v1/locales').set(bearer(randomToken())).expect(401);
    }
    for (let i = 0; i < 3; i += 1) {
      await t.http().get('/api/v1/locales').set(bearer(token)).expect(200);
    }
    for (let i = 0; i < 2; i += 1) {
      await t.http().get('/api/v1/locales').set(bearer(randomToken())).expect(401);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('hard-throttles token issuance per IP + email with Retry-After', async () => {
    await t.redis.flushdb();
    const attempt = (email: string) =>
      t.http().post('/api/v1/auth/tokens').send({ email, password: 'wrong-password', name: 'x' });
    await attempt('victim@test.local').expect(401);
    await attempt('victim@test.local').expect(401);
    const blocked = await attempt('victim@test.local').expect(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((blocked.body as Problem).type).toMatch(/rate-limited$/);
    // A different email from the same IP has its own budget.
    await attempt('other@test.local').expect(401);
  });

  it('limits the API per token, independently for each token', async () => {
    await t.redis.flushdb();
    const first = await t.token();
    const second = await t.token();
    for (let i = 0; i < 3; i += 1) {
      await t.http().get('/api/v1/locales').set(bearer(first)).expect(200);
    }
    const blocked = await t.http().get('/api/v1/tags').set(bearer(first)).expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    await t.http().get('/api/v1/locales').set(bearer(second)).expect(200);
  });

  it('applies a separate budget to the export', async () => {
    await t.redis.flushdb();
    const token = await t.token();
    await t.http().get('/api/v1/export/en').set(bearer(token)).expect(200);
    await t.http().get('/api/v1/export/en').set(bearer(token)).expect(200);
    await t.http().get('/api/v1/export/en').set(bearer(token)).expect(429);
    // The general API budget is untouched by export traffic.
    await t.http().get('/api/v1/locales').set(bearer(token)).expect(200);
  });

  it('never throttles health checks', async () => {
    for (let i = 0; i < 6; i += 1) await t.http().get('/api/v1/health/live').expect(200);
  });
});
