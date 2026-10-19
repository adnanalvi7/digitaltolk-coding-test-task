import type { Cluster, Worker } from 'node:cluster';

export interface ClusterLogger {
  info(message: string): void;
  error(message: string): void;
}

/** Minimal process surface, injectable for tests. */
export interface ProcessLike {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
}

/**
 * Runs `startWorker` in `workers` processes via Node's cluster module (the app
 * is stateless: rate limits, versions, caches and locks live in Redis or are
 * per-process by design). With one worker it simply starts in-process.
 *
 * The primary re-forks a worker that dies unexpectedly and forwards
 * SIGTERM/SIGINT so every worker shuts down gracefully (drain, close pools).
 */
export async function runClustered(
  workers: number,
  startWorker: () => Promise<void>,
  clusterApi: Pick<Cluster, 'isPrimary' | 'fork' | 'on' | 'workers'>,
  logger: ClusterLogger,
  processApi: ProcessLike = process,
): Promise<void> {
  if (workers <= 1 || !clusterApi.isPrimary) {
    await startWorker();
    return;
  }

  let shuttingDown = false;
  for (let i = 0; i < workers; i += 1) clusterApi.fork();
  logger.info(`Primary started ${workers} workers`);

  clusterApi.on('exit', (worker: Worker, code: number | null, signal: string | null) => {
    if (shuttingDown) return;
    logger.error(
      `Worker ${worker.process.pid ?? '?'} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}); restarting`,
    );
    clusterApi.fork();
  });

  const shutdown = (): void => {
    shuttingDown = true;
    for (const worker of Object.values(clusterApi.workers ?? {})) worker?.process.kill('SIGTERM');
  };
  processApi.once('SIGTERM', shutdown);
  processApi.once('SIGINT', shutdown);
}
