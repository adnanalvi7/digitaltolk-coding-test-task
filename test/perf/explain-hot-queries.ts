/**
 * Runs EXPLAIN (ANALYZE, BUFFERS) on the exact SQL the application executes
 * for every hot path: the real repository methods are called against a
 * seeded database, their compiled SQL + parameters are captured through
 * Kysely's log hook, and each statement is explained verbatim.
 *
 *   npm run perf:explain            (uses DATABASE_URL, expects 100k+ rows)
 */
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { KyselyTokenRepository } from '../../src/auth/repositories/token.repository';
import { loadDotEnv } from '../../src/cli/load-dot-env';
import { loadConfig } from '../../src/config/app-config';
import type { DB } from '../../src/database/schema.generated';
import { KyselyExportRepository } from '../../src/export/export.repository';
import { KyselyTranslationQueryRepository } from '../../src/translations/translation-query.repository';
import { type SearchCriteria, TagMatchMode } from '../../src/translations/translation.model';

const LARGE_TABLES = ['translations', 'translation_keys', 'translation_key_tags'];
/** An index walk discarding more rows than this is effectively a full scan. */
const MAX_ROWS_REMOVED_BY_FILTER = 10_000;
/** Per-statement budget for search/list SQL (the HTTP budget is 200 ms end to end). */
const MAX_SEARCH_STATEMENT_MS = 50;

/**
 * A full-locale export must read every translation key, i.e. 100% of
 * translation_keys. Measured alternatives on 200k rows (see README): forcing an
 * index-only scan in key order (to skip the sort) is ~2x slower (116 ms vs
 * 63 ms median) than hash join + seq scan + in-memory sort. So a seq scan of
 * that table is expected here; on every other table and path it is a failure.
 */
const EXPECTED_FULL_READS: Readonly<Record<string, string>> = {
  'export: full locale (en)': 'translation_keys',
  'export: locale filtered by tag "mobile"': 'translation_keys',
};

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const base: SearchCriteria = {
  keyPrefix: undefined,
  text: undefined,
  tags: undefined,
  localeCode: undefined,
  afterId: undefined,
  limit: 50,
};

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig(process.env);
  let captured: Captured[] = [];
  let capturing = false;
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.db.url, max: 2 }) }),
    log: (event) => {
      if (capturing && event.level === 'query') {
        captured.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });
  const reads = new KyselyTranslationQueryRepository(db);
  const exports = new KyselyExportRepository(db);
  const tokens = new KyselyTokenRepository(db);
  const { id: maxId } = await db
    .selectFrom('translation_keys')
    .select((eb) => eb.fn.max('id').as('id'))
    .executeTakeFirstOrThrow();
  const en = await db
    .selectFrom('locales')
    .select('id')
    .where('code', '=', 'en')
    .executeTakeFirstOrThrow();
  const deepCursor = String(Math.floor(Number(maxId) * 0.9));

  const scenarios: [string, () => Promise<unknown>][] = [
    ['list: first page (limit 50)', () => reads.search(base)],
    [
      'list: deep keyset page (cursor at 90%)',
      () => reads.search({ ...base, afterId: deepCursor }),
    ],
    [
      'search: key prefix "checkout.button."',
      () => reads.search({ ...base, keyPrefix: 'checkout.button.' }),
    ],
    ['search: content word "payment"', () => reads.search({ ...base, text: 'payment' })],
    ['search: content substring "ccoun"', () => reads.search({ ...base, text: 'ccoun' })],
    // Worst cases for any "walk keys in order and probe" plan: nothing (or
    // almost nothing) matches, so the LIMIT never short-circuits the scan.
    ['search: content with no match "zqxjkv"', () => reads.search({ ...base, text: 'zqxjkv' })],
    ['search: content rare substring "#4999"', () => reads.search({ ...base, text: '#4999' })],
    [
      'search: content word "bestellung" in de',
      () => reads.search({ ...base, text: 'bestellung', localeCode: 'de' }),
    ],
    [
      'search: tags any "mobile"',
      () => reads.search({ ...base, tags: { names: ['mobile'], mode: TagMatchMode.Any } }),
    ],
    [
      'search: tags all "web,mobile"',
      () => reads.search({ ...base, tags: { names: ['web', 'mobile'], mode: TagMatchMode.All } }),
    ],
    [
      'search: prefix + tags + content',
      () =>
        reads.search({
          ...base,
          keyPrefix: 'checkout.',
          text: 'pay',
          tags: { names: ['web'], mode: TagMatchMode.Any },
        }),
    ],
    ['show: findById', () => reads.findById(String(Math.floor(Number(maxId) / 2)))],
    ['export: full locale (en)', () => exports.fetchEntries(en.id, undefined)],
    [
      'export: locale filtered by tag "mobile"',
      () => exports.fetchEntries(en.id, { names: ['mobile'], mode: TagMatchMode.Any }),
    ],
    ['auth: token lookup by hash', () => tokens.findByHash('0'.repeat(64))],
  ];

  let failures = 0;
  for (const [label, run] of scenarios) {
    captured = [];
    capturing = true;
    await run();
    capturing = false;
    const statements = captured;
    for (const [index, statement] of statements.entries()) {
      const { rows } = await db.executeQuery<{ 'QUERY PLAN': string }>(
        CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, [...statement.parameters]),
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      const seqScans = LARGE_TABLES.filter((table) =>
        new RegExp(`Seq Scan on ${table}\\b`).test(plan),
      );
      const unexpected = seqScans.filter((table) => EXPECTED_FULL_READS[label] !== table);
      const time = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? '?';
      const discarded = Math.max(
        0,
        ...[...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1])),
      );
      const isSearch = !label.startsWith('export');
      const problems = [
        ...(unexpected.length > 0 ? [`SEQ SCAN on ${unexpected.join(', ')}`] : []),
        // An index walk that filters away most of a table is a seq scan in disguise.
        ...(discarded > MAX_ROWS_REMOVED_BY_FILTER ? [`${discarded} rows removed by filter`] : []),
        ...(isSearch && Number(time) > MAX_SEARCH_STATEMENT_MS ? [`${time} ms > budget`] : []),
      ];
      const verdict =
        problems.length > 0
          ? problems.join('; ')
          : seqScans.length > 0
            ? `indexed + expected full read of ${seqScans.join(', ')}`
            : 'index only';
      if (problems.length > 0) failures += 1;
      process.stdout.write(
        `\n=== ${label} [stmt ${index + 1}/${statements.length}] ${time} ms — ${verdict}\n`,
      );
      process.stdout.write(`${statement.sql.replace(/\s+/g, ' ').trim()}\n${plan}\n`);
    }
  }
  await db.destroy();
  process.stdout.write(
    `\n${failures === 0 ? 'OK' : 'FAIL'}: ${failures} statement(s) with an unexpected seq scan, ` +
      `> ${MAX_ROWS_REMOVED_BY_FILTER} rows removed by filter, or a search statement > ${MAX_SEARCH_STATEMENT_MS} ms\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
