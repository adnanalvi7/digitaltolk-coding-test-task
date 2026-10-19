import type { Cluster, Worker } from 'node:cluster';
import { type ProcessLike, runClustered } from './run-clustered';

type ExitHandler = (worker: Worker, code: number | null, signal: string | null) => void;

function fakeCluster(isPrimary = true) {
  const forked: { kill: jest.Mock }[] = [];
  let onExit: ExitHandler = () => undefined;
  const api = {
    isPrimary,
    fork: jest.fn(() => {
      const worker = { process: { pid: forked.length + 1, kill: jest.fn() } };
      forked.push(worker.process);
      return worker;
    }),
    on: jest.fn((_event: string, handler: ExitHandler) => {
      onExit = handler;
    }),
    get workers() {
      return Object.fromEntries(forked.map((p, i) => [String(i), { process: p }]));
    },
  };
  return {
    api: api as unknown as Pick<Cluster, 'isPrimary' | 'fork' | 'on' | 'workers'>,
    forked,
    fork: api.fork,
    exit: (code: number) => {
      onExit({ process: { pid: 7 } } as unknown as Worker, code, null);
    },
  };
}

function fakeProcess() {
  const handlers = new Map<string, () => void>();
  const api: ProcessLike = {
    once: (signal, handler) => {
      handlers.set(signal, handler);
    },
  };
  return { api, signal: (name: string) => handlers.get(name)?.() };
}

const logger = { info: jest.fn(), error: jest.fn() };

describe('runClustered', () => {
  it('starts in-process with a single worker', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    const cluster = fakeCluster();
    await runClustered(1, start, cluster.api, logger, fakeProcess().api);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cluster.fork).not.toHaveBeenCalled();
  });

  it('starts the app inside forked workers', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    await runClustered(4, start, fakeCluster(false).api, logger, fakeProcess().api);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('forks N workers from the primary and restarts crashed ones', async () => {
    const start = jest.fn();
    const cluster = fakeCluster();
    await runClustered(3, start, cluster.api, logger, fakeProcess().api);
    expect(start).not.toHaveBeenCalled();
    expect(cluster.fork).toHaveBeenCalledTimes(3);
    cluster.exit(1);
    expect(cluster.fork).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalled();
  });

  it('forwards SIGTERM to workers and stops restarting them', async () => {
    const cluster = fakeCluster();
    const proc = fakeProcess();
    await runClustered(2, jest.fn(), cluster.api, logger, proc.api);
    proc.signal('SIGTERM');
    expect(cluster.forked.every((p) => p.kill.mock.calls.length === 1)).toBe(true);
    cluster.exit(0);
    expect(cluster.fork).toHaveBeenCalledTimes(2);
  });
});
