import { setImmediate as nextTurn } from 'node:timers/promises';

/** Lets pending I/O callbacks run between chunks of CPU-bound work. */
export async function yieldToEventLoop(): Promise<void> {
  await nextTurn();
}

/** Default chunk size for cooperative loops over large arrays. */
export const COOPERATIVE_CHUNK_SIZE = 5_000;

/**
 * Maps a large array in chunks, yielding to the event loop between chunks so
 * other requests keep being served while O(n) work runs.
 */
export async function mapCooperatively<T, R>(
  items: readonly T[],
  mapper: (item: T) => R,
  chunkSize = COOPERATIVE_CHUNK_SIZE,
): Promise<R[]> {
  const output: R[] = new Array<R>(items.length);
  for (let start = 0; start < items.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, items.length);
    for (let index = start; index < end; index += 1) {
      output[index] = mapper(items[index] as T);
    }
    if (end < items.length) await yieldToEventLoop();
  }
  return output;
}
