/**
 * Trailing debounce that only ever runs the most recent argument, one run at a
 * time. A burst of N calls within `delayMs` (or while a run is in progress)
 * collapses into a single run with the last argument; every caller in the
 * burst receives that run's promise.
 *
 * Used for post-commit side effects (CDN purge, export warming), where only the
 * latest catalog version matters and per-write fan-out would amplify load.
 */
export function latestOnly<T>(
  task: (argument: T) => Promise<void>,
  delayMs: number,
): (argument: T) => Promise<void> {
  let queued: { argument: T; done: PromiseWithResolvers<undefined> } | undefined;
  let chain: Promise<void> = Promise.resolve();

  return (argument: T) => {
    if (queued) {
      queued.argument = argument;
      return queued.done.promise;
    }
    const entry = { argument, done: Promise.withResolvers<undefined>() };
    queued = entry;
    setTimeout(() => {
      chain = chain.then(async () => {
        // Detach before running: calls arriving now schedule the next run.
        if (queued === entry) queued = undefined;
        try {
          await task(entry.argument);
          entry.done.resolve(undefined);
        } catch (error: unknown) {
          entry.done.reject(error);
        }
      });
    }, delayMs);
    return entry.done.promise;
  };
}
