/**
 * Compares cold-export build strategies on a seeded database:
 *   A) one query returning rows + JS formatter (what the service does)
 *   B) Postgres builds the JSON itself via json_object_agg(... ORDER BY key)
 * and the cost of compressing the result.
 *
 *   npm run perf:export-build
 */
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { sql } from 'kysely';
import { loadDotEnv } from '../../src/cli/load-dot-env';
import { loadConfig } from '../../src/config/app-config';
import { createKysely } from '../../src/database/kysely.factory';
import { KyselyExportRepository } from '../../src/export/export.repository';
import { FlatExportFormatter } from '../../src/export/formatters/flat-export.formatter';
import { NestedExportFormatter } from '../../src/export/formatters/nested-export.formatter';

const RUNS = 9;
/** Matches GZIP_LEVEL in ExportService. */
const SHIPPED_GZIP_LEVEL = 4;
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

async function median(label: string, task: () => Promise<unknown>): Promise<number> {
  await task(); // warm-up (plan cache, buffers)
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    await task();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const value = samples[Math.floor(RUNS / 2)] ?? Number.NaN;
  process.stdout.write(
    `${label.padEnd(58)} median ${value.toFixed(1).padStart(7)} ms   (min ${samples[0]?.toFixed(1)}, max ${samples.at(-1)?.toFixed(1)})\n`,
  );
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();
  const db = createKysely(loadConfig(process.env).db);
  const repository = new KyselyExportRepository(db);
  const flat = new FlatExportFormatter();
  const nested = new NestedExportFormatter();
  const { id: localeId } = await db
    .selectFrom('locales')
    .select('id')
    .where('code', '=', 'en')
    .executeTakeFirstOrThrow();
  const entries = await repository.fetchEntries(localeId, undefined);
  const json = await flat.render(entries);
  process.stdout.write(
    `\nDataset: ${entries.length} entries for "en", flat JSON ${(json.length / 1e6).toFixed(2)} MB\n\n`,
  );

  const rowsQuery = await median(
    'A1  query rows (Kysely, SELECT key, value ... ORDER BY key)',
    () => repository.fetchEntries(localeId, undefined),
  );
  const flatRender = await median('A2  render flat JSON in JS (cooperative)', () =>
    flat.render(entries),
  );
  await median('A2b render nested JSON in JS (cooperative)', () => nested.render(entries));
  const aggregate = await median('B   json_object_agg in Postgres (returns one text value)', () =>
    sql<{ doc: string }>`
      SELECT json_object_agg(tk.key, t.value ORDER BY tk.key)::text AS doc
      FROM translations t JOIN translation_keys tk ON tk.id = t.translation_key_id
      WHERE t.locale_id = ${localeId}
    `.execute(db),
  );
  const buffer = Buffer.from(json, 'utf8');
  const gz4 = await median('C1  gzip level 4 (used)', () =>
    gzipAsync(buffer, { level: SHIPPED_GZIP_LEVEL }),
  );
  await median('C2  gzip level 6', () => gzipAsync(buffer, { level: 6 }));
  await median('C3  gzip level 1', () => gzipAsync(buffer, { level: 1 }));
  await median('C4  brotli quality 4', () =>
    brotliAsync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
  );
  for (const level of [SHIPPED_GZIP_LEVEL, 6]) {
    const size = (await gzipAsync(buffer, { level })).length;
    process.stdout.write(
      `gzip-${level} size: ${(size / 1e3).toFixed(0)} kB (${((size / buffer.length) * 100).toFixed(1)}% of raw)\n`,
    );
  }
  process.stdout.write(
    `\nStrategy A total (query + render + gzip-4): ${(rowsQuery + flatRender + gz4).toFixed(1)} ms\n`,
  );
  process.stdout.write(
    `Strategy B total (aggregate + gzip-4):     ${(aggregate + gz4).toFixed(1)} ms\n`,
  );
  await db.destroy();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
