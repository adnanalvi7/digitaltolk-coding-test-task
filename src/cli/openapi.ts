import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from '../app.factory';
import { loadConfig } from '../config/app-config';
import { buildOpenApiDocument } from '../openapi';

/**
 * Writes the OpenAPI document to docs/openapi.json without serving traffic.
 * No database or Redis round trip is made: connections are lazy and the
 * document is derived purely from controller/DTO metadata.
 */
async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? 'docs/openapi.json');
  const config = loadConfig({
    DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:5432/openapi',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    ...process.env,
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'false',
  });
  const app = await createApp(config);
  try {
    const document = buildOpenApiDocument(app);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(
      `OpenAPI document written to ${output} (${Object.keys(document.paths).length} paths)\n`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
