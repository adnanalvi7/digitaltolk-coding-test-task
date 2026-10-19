import 'reflect-metadata';
import cluster from 'node:cluster';
import { createApp } from './app.factory';
import { loadDotEnv } from './cli/load-dot-env';
import { runClustered } from './cluster/run-clustered';
import { loadConfig } from './config/app-config';

const stderrLogger = {
  info: (message: string): void => {
    process.stdout.write(`${message}\n`);
  },
  error: (message: string): void => {
    process.stderr.write(`${message}\n`);
  },
};

async function bootstrap(): Promise<void> {
  loadDotEnv();
  const config = loadConfig(process.env);
  await runClustered(
    config.app.workers,
    async () => {
      const app = await createApp(config);
      await app.listen({ host: config.app.host, port: config.app.port });
    },
    cluster,
    stderrLogger,
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${String(error)}\n`);
  process.exit(1);
});
