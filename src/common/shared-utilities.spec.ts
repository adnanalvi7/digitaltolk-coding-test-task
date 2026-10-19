import { latestOnly } from './async/latest-only';
import { SingleFlight } from './async/single-flight';
import { mapCooperatively, yieldToEventLoop } from './async/yield-to-event-loop';
import { BoundedLru } from './cache/bounded-lru';
import { sha256Hex, shortDigest } from './crypto/hash';
import { isRecord, numberProperty, stringProperty } from './type-guards';
import { msToSeconds, secondsToMs } from './units';

describe('SingleFlight', () => {
  it('shares one in-flight task per key and starts fresh after it settles', async () => {
    const flight = new SingleFlight<string, number>();
    let calls = 0;
    const task = () => {
      calls += 1;
      const invocation = calls;
      return new Promise<number>((resolve) =>
        setTimeout(() => {
          resolve(invocation);
        }, 5),
      );
    };
    const results = await Promise.all([
      flight.run('a', task),
      flight.run('a', task),
      flight.run('b', task),
    ]);
    expect(results).toEqual([1, 1, 2]);
    expect(flight.size).toBe(0);
    expect(await flight.run('a', task)).toBe(3);
  });

  it('propagates rejections to every caller and then forgets the key', async () => {
    const flight = new SingleFlight<string, number>();
    const failing = () => Promise.reject(new Error('boom'));
    await expect(Promise.all([flight.run('k', failing), flight.run('k', failing)])).rejects.toThrow(
      'boom',
    );
    expect(flight.size).toBe(0);
  });
});

describe('latestOnly', () => {
  it('collapses a burst into one run with the latest argument', async () => {
    const seen: number[] = [];
    const run = latestOnly((value: number) => {
      seen.push(value);
      return Promise.resolve();
    }, 5);
    await Promise.all([run(1), run(2), run(3)]);
    expect(seen).toEqual([3]);
  });

  it('runs again for calls that arrive after a run has started, never concurrently', async () => {
    const seen: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = latestOnly(async (value: number) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(value);
      concurrent -= 1;
    }, 1);
    const first = run(1);
    await new Promise((resolve) => setTimeout(resolve, 5)); // first run is now in progress
    await Promise.all([first, run(2), run(3)]);
    expect(seen).toEqual([1, 3]);
    expect(maxConcurrent).toBe(1);
  });

  it('rejects the burst promise when the task fails, and keeps working afterwards', async () => {
    let fail = true;
    const run = latestOnly(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve()), 1);
    await expect(run(1)).rejects.toThrow('down');
    fail = false;
    await expect(run(2)).resolves.toBeUndefined();
  });
});

describe('cooperative iteration', () => {
  it('maps every item in order across chunks', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(await mapCooperatively(items, (n) => n * 2, 10)).toEqual(items.map((n) => n * 2));
    expect(await mapCooperatively([], (n: number) => n)).toEqual([]);
  });

  it('lets other callbacks run between chunks', async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    await mapCooperatively([1, 2, 3], (n) => n, 1);
    expect(ticked).toBe(true);
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});

describe('BoundedLru', () => {
  it('evicts least recently used entries beyond the weight budget', () => {
    const lru = new BoundedLru<string, string>({ maxWeight: 2 });
    lru.set('a', 'A');
    lru.set('b', 'B');
    expect(lru.get('a')).toBe('A'); // refresh a
    lru.set('c', 'C');
    expect(lru.get('b')).toBeUndefined();
    expect([lru.get('a'), lru.get('c')]).toEqual(['A', 'C']);
    expect(lru.size).toBe(2);
  });

  it('weighs entries, replaces without double counting and skips oversized values', () => {
    const lru = new BoundedLru<string, Buffer>({ maxWeight: 10, weigh: (b) => b.length });
    lru.set('x', Buffer.alloc(4));
    lru.set('x', Buffer.alloc(6));
    expect(lru.weight).toBe(6);
    lru.set('huge', Buffer.alloc(11));
    expect(lru.get('huge')).toBeUndefined();
    lru.delete('x');
    lru.delete('missing');
    expect(lru.weight).toBe(0);
  });

  it('expires entries after their TTL', () => {
    let now = 0;
    const lru = new BoundedLru<string, number>({ maxWeight: 5, ttlMs: 100, now: () => now });
    lru.set('k', 1);
    now = 99;
    expect(lru.get('k')).toBe(1);
    now = 100;
    expect(lru.get('k')).toBeUndefined();
    expect(lru.size).toBe(0);
  });
});

describe('hashing, type guards and units', () => {
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(shortDigest('abc')).toHaveLength(16);
    expect(shortDigest('abc', 8)).toMatch(/^[\w-]{8}$/);
  });

  it('narrows unknown values safely', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(stringProperty({ code: '23505' }, 'code')).toBe('23505');
    expect(stringProperty({ code: 1 }, 'code')).toBeUndefined();
    expect(stringProperty('nope', 'code')).toBeUndefined();
    expect(numberProperty({ statusCode: 413 }, 'statusCode')).toBe(413);
    expect(numberProperty({ statusCode: '413' }, 'statusCode')).toBeUndefined();
    expect(numberProperty(undefined, 'statusCode')).toBeUndefined();
  });

  it('converts units', () => {
    expect(secondsToMs(2)).toBe(2000);
    expect(msToSeconds(1500)).toBe(1.5);
  });
});
