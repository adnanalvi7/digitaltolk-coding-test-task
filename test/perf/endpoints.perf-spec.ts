/**
 * Load-tests every endpoint with autocannon against a separately spawned,
 * compiled server (so load generation does not share its event loop) on a
 * database holding 100k+ translations. Fails if any threshold is breached.
 *
 *   npm run test:perf
 */
import autocannon, { type Options, type Request, type Result } from 'autocannon';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { sql } from 'kysely';
import { Redis } from 'ioredis';
import { Argon2PasswordHasher } from '../../src/auth/password-hasher';
import { KyselyUserRepository } from '../../src/auth/repositories/user.repository';
import { KyselyCatalogChangeLog } from '../../src/catalog-events/catalog-change-log';
import { RedisVersionStore } from '../../src/catalog-events/version-store';
import { encodeCursor } from '../../src/common/pagination/cursor';
import { loadConfig } from '../../src/config/app-config';
import { type Database, createKysely } from '../../src/database/kysely.factory';
import { migrateToLatest } from '../../src/database/migrations';
import { provisionAdmin } from '../../src/seeding/admin-provisioner';
import { Seeder } from '../../src/seeding/seeder';

/**
 * Jest sandboxes process.env, so `.env` is parsed explicitly; real environment
 * variables (e.g. in CI) take precedence over the file.
 */
const perfEnv: Record<string, string | undefined> = {
  ...(existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}),
  ...process.env,
};

const MIN_TRANSLATIONS = 100_000;
const DURATION_SECONDS = Number(process.env.PERF_DURATION_SECONDS ?? 15);
const CONNECTIONS = Number(process.env.PERF_CONNECTIONS ?? 50);
/** Server cluster workers for the run (the app is stateless; see APP_WORKERS). */
const SERVER_WORKERS = process.env.PERF_WORKERS ?? '2';
const PORT = Number(process.env.PERF_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const PERF_EMAIL = 'perf@bench.local';
const PERF_PASSWORD = 'perf-bench-password-123';
const CRUD_P95_BUDGET_MS = 200;
const COLD_EXPORT_BUDGET_MS = 500;
/**
 * The export requirement (< 500 ms). Warm hits do ~no server work (served from
 * memory), but at 50 connections each ~0.6 MB response is bound by transfer:
 * 50 × 0.58 MB through ~224 MB/s of loopback is > 130 ms per cycle on this host.
 */
const WARM_EXPORT_P95_BUDGET_MS = 500;
const NOT_MODIFIED_P95_BUDGET_MS = 50;
const COLD_EXPORT_SAMPLES = 15;
const CLIENT_WORKERS = 4;

interface Row {
  readonly scenario: string;
  readonly requests: number;
  readonly rps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly errors: number;
  readonly budget: number;
  /** Status code histogram (diagnostics for failed runs). */
  readonly statuses?: Readonly<Record<number, number>>;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
  );
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('server did not become healthy');
}

describe('Performance (autocannon, 100k+ rows)', () => {
  let server: ChildProcess;
  let db: Database;
  let redis: Redis;
  let token: string;
  let ids: string[] = [];
  const rows: Row[] = [];

  beforeAll(async () => {
    const config = loadConfig(perfEnv);
    db = createKysely(config.db);
    redis = new Redis(config.redis.url, { keyPrefix: config.redis.keyPrefix });
    await migrateToLatest(db);

    const { rows: counts } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM translations`.execute(db);
    if ((counts[0]?.n ?? 0) < MIN_TRANSLATIONS) {
      await new Seeder(db).run(
        {
          keys: 50_000,
          locales: ['en', 'fr', 'es', 'de'],
          tags: ['mobile', 'desktop', 'web'],
          batchSize: 5_000,
          seed: 42,
          fresh: true,
        },
        {
          afterSeed: async () => {
            const changeLog = new KyselyCatalogChangeLog(db);
            await new RedisVersionStore(redis, changeLog).publish(await changeLog.record(db));
          },
        },
      );
    }
    await provisionAdmin(new KyselyUserRepository(db), new Argon2PasswordHasher(), {
      email: PERF_EMAIL,
      password: PERF_PASSWORD,
    });
    ids = (
      await db.selectFrom('translation_keys').select('id').orderBy('id').limit(20_000).execute()
    ).map((r) => r.id);

    server = spawn(process.execPath, [join(process.cwd(), 'dist', 'main.js')], {
      env: {
        ...perfEnv,
        PORT: String(PORT),
        NODE_ENV: 'production',
        APP_WORKERS: SERVER_WORKERS,
        LOG_LEVEL: 'warn',
        THROTTLE_AUTH_LIMIT: '1000',
        THROTTLE_API_LIMIT: '100000000',
        THROTTLE_EXPORT_LIMIT: '100000000',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForHealth();

    const response = await fetch(`${BASE}/api/v1/auth/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: PERF_EMAIL,
        password: PERF_PASSWORD,
        name: 'perf',
        ttlSeconds: 3600,
      }),
    });
    token = ((await response.json()) as { data: { token: string } }).data.token;
  });

  afterAll(async () => {
    server.kill();
    await sql`DELETE FROM translation_keys WHERE key LIKE 'perf.%'`.execute(db);
    await db.destroy();
    await redis.quit();
    printAndPersist(rows);
  });

  const randomId = (): string => ids[Math.floor(Math.random() * ids.length)] ?? '1';

  async function load(
    scenario: string,
    budget: number,
    request: Partial<Request>,
    isExpected: (status: number) => boolean = (status) => status >= 200 && status < 300,
  ): Promise<Row> {
    const latencies: number[] = [];
    let unexpected = 0;
    const statuses: Record<number, number> = {};
    const result = await new Promise<Result>((resolve, reject) => {
      const instance = autocannon(baseOptions(request), (error: Error | null, finished) => {
        if (error) reject(error);
        else resolve(finished);
      });
      instance.on('response', (_client, status, _bytes, responseTime) => {
        latencies.push(responseTime);
        if (!isExpected(status)) unexpected += 1;
        statuses[status] = (statuses[status] ?? 0) + 1;
      });
    });
    latencies.sort((a, b) => a - b);
    if (unexpected > 0) {
      process.stdout.write(`[${scenario}] unexpected statuses: ${JSON.stringify(statuses)}\n`);
    }
    return record({
      scenario,
      requests: result.requests.total,
      rps: Math.round(result.requests.average),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.at(-1) ?? Number.NaN,
      errors: result.errors + result.timeouts + unexpected,
      statuses,
      budget,
    });
  }

  /**
   * For large payloads (~0.6 MB gzip per export) a single-threaded autocannon
   * client saturates before the server does, so these scenarios spread the
   * client over worker threads. Per-response events are unavailable in that
   * mode, so p97.5 from autocannon's histogram is reported as an upper bound
   * for p95.
   */
  async function loadWithClientWorkers(
    scenario: string,
    budget: number,
    request: Partial<Request>,
  ): Promise<Row> {
    const result = await autocannon({ ...baseOptions(request), workers: CLIENT_WORKERS });
    return record({
      scenario: `${scenario} †`,
      requests: result.requests.total,
      rps: Math.round(result.requests.average),
      p50: result.latency.p50,
      p95: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
      errors: result.errors + result.timeouts + result.non2xx,
      budget,
    });
  }

  function baseOptions(request: Partial<Request>): Options {
    return {
      url: BASE,
      connections: CONNECTIONS,
      duration: DURATION_SECONDS,
      headers: {
        authorization: `Bearer ${token}`,
        'accept-encoding': 'gzip',
        'content-type': 'application/json',
      },
      requests: [request],
    };
  }

  function record(row: Row): Row {
    rows.push(row);
    return row;
  }

  const get = (path: string) => ({ method: 'GET' as const, path });

  it.each([
    ['GET /translations (first page, 50)', get('/api/v1/translations?limit=50')],
    [
      'GET /translations?key=checkout.button.',
      get('/api/v1/translations?key=checkout.button.&limit=50'),
    ],
    ['GET /translations?q=payment (word)', get('/api/v1/translations?q=payment&limit=50')],
    ['GET /translations?q=ccoun (substring)', get('/api/v1/translations?q=ccoun&limit=50')],
    ['GET /translations?q=zqxjkv (no match)', get('/api/v1/translations?q=zqxjkv&limit=50')],
    ['GET /translations?q=%234999 (rare)', get('/api/v1/translations?q=%234999&limit=50')],
    ['GET /translations?tags=mobile', get('/api/v1/translations?tags=mobile&limit=50')],
    [
      'GET /translations?tags=web,mobile&tagsMode=all',
      get('/api/v1/translations?tags=web,mobile&tagsMode=all&limit=50'),
    ],
    [
      'GET /translations?locale=fr&q=paiement',
      get('/api/v1/translations?locale=fr&q=paiement&limit=50'),
    ],
    ['GET /locales', get('/api/v1/locales')],
    ['GET /tags', get('/api/v1/tags')],
  ])('%s: p95 < 200 ms', async (scenario, request) => {
    const row = await load(scenario, CRUD_P95_BUDGET_MS, request);
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(CRUD_P95_BUDGET_MS);
  });

  it('GET /translations?cursor=(deep page): p95 < 200 ms', async () => {
    const cursor = encodeCursor(ids.at(-1) ?? '1');
    const row = await load(
      'GET /translations?cursor=… (deep page)',
      CRUD_P95_BUDGET_MS,
      get(`/api/v1/translations?limit=50&cursor=${cursor}`),
    );
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(CRUD_P95_BUDGET_MS);
  });

  it('GET /translations/:id (random ids): p95 < 200 ms', async () => {
    const row = await load('GET /translations/:id', CRUD_P95_BUDGET_MS, {
      method: 'GET',
      setupRequest: (req) => ({ ...req, path: `/api/v1/translations/${randomId()}` }),
    });
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(CRUD_P95_BUDGET_MS);
  });

  it('POST /translations (create): p95 < 200 ms', async () => {
    let n = 0;
    const run = Date.now();
    const row = await load('POST /translations', CRUD_P95_BUDGET_MS, {
      method: 'POST',
      path: '/api/v1/translations',
      setupRequest: (req) => {
        n += 1;
        return {
          ...req,
          body: JSON.stringify({
            key: `perf.c${run}.k_${n}`,
            values: { en: `Perf ${n}`, fr: `Perf ${n}` },
            tags: ['perf'],
          }),
        };
      },
    });
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(CRUD_P95_BUDGET_MS);
  });

  it('PATCH /translations/:id (merge values): p95 < 200 ms', async () => {
    const row = await load('PATCH /translations/:id', CRUD_P95_BUDGET_MS, {
      method: 'PATCH',
      setupRequest: (req) => ({
        ...req,
        path: `/api/v1/translations/${randomId()}`,
        body: JSON.stringify({ values: { es: `Editado ${Date.now()}` } }),
      }),
    });
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(CRUD_P95_BUDGET_MS);
  });

  it('GET /export/en cold (cache miss after a write): < 500 ms every time', async () => {
    const samples: number[] = [];
    const etags = new Set<string>();
    for (let i = 0; i < COLD_EXPORT_SAMPLES; i += 1) {
      const bump = await fetch(`${BASE}/api/v1/translations/${randomId()}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ values: { en: `Cold ${i} ${Date.now()}` } }),
      });
      expect(bump.status).toBe(200);
      const start = performance.now();
      const response = await fetch(`${BASE}/api/v1/export/en`, {
        headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
      });
      await response.arrayBuffer();
      samples.push(performance.now() - start);
      expect(response.status).toBe(200);
      // A "cold" sample is only valid if the write produced a new version:
      // a repeated ETag would mean a stale cache hit, not a fast build.
      const etag = response.headers.get('etag') ?? '';
      expect(etags.has(etag)).toBe(false);
      etags.add(etag);
    }
    process.stdout.write(
      `[cold export] samples in order (ms): ${samples.map((s) => Math.round(s)).join(', ')}\n`,
    );
    samples.sort((a, b) => a - b);
    rows.push({
      scenario: `GET /export/en cold (n=${COLD_EXPORT_SAMPLES}, sequential)`,
      requests: COLD_EXPORT_SAMPLES,
      rps: Number.NaN,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples.at(-1) ?? Number.NaN,
      errors: 0,
      budget: COLD_EXPORT_BUDGET_MS,
    });
    expect(samples.at(-1)).toBeLessThan(COLD_EXPORT_BUDGET_MS);
  });

  it('GET /export/en warm (gzip from cache): p95 < 500 ms', async () => {
    await fetch(`${BASE}/api/v1/export/en`, { headers: { authorization: `Bearer ${token}` } });
    const row = await loadWithClientWorkers(
      'GET /export/en warm (pre-gzipped)',
      WARM_EXPORT_P95_BUDGET_MS,
      get('/api/v1/export/en'),
    );
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(WARM_EXPORT_P95_BUDGET_MS);
  });

  it('GET /export/en?format=nested warm: p95 < 500 ms', async () => {
    await fetch(`${BASE}/api/v1/export/en?format=nested`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = await loadWithClientWorkers(
      'GET /export/en?format=nested warm',
      WARM_EXPORT_P95_BUDGET_MS,
      get('/api/v1/export/en?format=nested'),
    );
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(WARM_EXPORT_P95_BUDGET_MS);
  });

  it('GET /export/en with If-None-Match (304): p95 < 50 ms', async () => {
    const etag =
      (
        await fetch(`${BASE}/api/v1/export/en`, { headers: { authorization: `Bearer ${token}` } })
      ).headers.get('etag') ?? '';
    const row = await load(
      'GET /export/en 304 (If-None-Match)',
      NOT_MODIFIED_P95_BUDGET_MS,
      {
        method: 'GET',
        path: '/api/v1/export/en',
        headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
      },
      (status) => status === 304,
    );
    expect(etag).toMatch(/^W\//);
    expect(row.errors).toBe(0);
    expect(row.p95).toBeLessThan(NOT_MODIFIED_P95_BUDGET_MS);
  });
});

function printAndPersist(rows: readonly Row[]): void {
  const fmt = (n: number): string => (Number.isNaN(n) ? '–' : n.toFixed(n < 10 ? 1 : 0));
  const header =
    '| Scenario | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Budget | Result |';
  const lines = rows.map(
    (r) =>
      `| ${r.scenario} | ${r.requests} | ${fmt(r.rps)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.budget} ms | ${r.scenario.includes('cold') ? (r.max < r.budget ? 'PASS' : 'FAIL') : r.p95 < r.budget ? 'PASS' : 'FAIL'} |`,
  );
  const environment = `Node ${process.version}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'} (${cpus().length} threads), ${(totalmem() / 1024 ** 3).toFixed(0)} GB RAM, ${CONNECTIONS} connections × ${DURATION_SECONDS}s per scenario, ${SERVER_WORKERS} server workers`;
  const table = [
    environment,
    '',
    header,
    '|---|---:|---:|---:|---:|---:|---:|---:|:---:|',
    ...lines,
    '',
    `† ${CLIENT_WORKERS} autocannon worker threads (a single client thread saturates on ~0.6 MB bodies before the server does); "p95" column shows p97.5, an upper bound.`,
  ].join('\n');
  process.stdout.write(`\n${table}\n`);
  mkdirSync('perf-results', { recursive: true });
  writeFileSync(join('perf-results', 'latest.md'), `${table}\n`);
}
