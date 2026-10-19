import { ExportCache, MemoryLayeredExportCache } from './export-cache';

class FakeBackingCache extends ExportCache {
  readonly store = new Map<string, Buffer>();
  readonly gets: string[] = [];

  get(key: string): Promise<Buffer | null> {
    this.gets.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: Buffer): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  acquireBuildLock = jest.fn().mockResolvedValue('owner');
  releaseBuildLock = jest.fn().mockResolvedValue(undefined);
}

const bytes = (n: number): Buffer => Buffer.alloc(n, 1);

describe('MemoryLayeredExportCache', () => {
  it('writes through and serves later reads from memory', async () => {
    const backing = new FakeBackingCache();
    const cache = new MemoryLayeredExportCache(backing, 100);
    await cache.set('a', bytes(10), 60);
    expect(backing.store.has('a')).toBe(true);
    expect(await cache.get('a')).toEqual(bytes(10));
    expect(backing.gets).toEqual([]);
  });

  it('populates memory from the backing cache on a local miss', async () => {
    const backing = new FakeBackingCache();
    backing.store.set('b', bytes(5));
    const cache = new MemoryLayeredExportCache(backing, 100);
    expect(await cache.get('b')).toEqual(bytes(5));
    await cache.get('b');
    expect(backing.gets).toEqual(['b']);
    expect(await cache.get('missing')).toBeNull();
  });

  it('evicts least recently used entries beyond the byte budget', async () => {
    const backing = new FakeBackingCache();
    const cache = new MemoryLayeredExportCache(backing, 25);
    await cache.set('old', bytes(10), 60);
    await cache.set('mid', bytes(10), 60);
    await cache.get('old'); // refresh "old"
    await cache.set('new', bytes(10), 60);
    expect(cache.size).toBe(20);
    backing.store.clear();
    expect(await cache.get('old')).not.toBeNull();
    expect(await cache.get('new')).not.toBeNull();
    expect(await cache.get('mid')).toBeNull();
  });

  it('replaces an existing entry without double-counting and skips oversized documents', async () => {
    const backing = new FakeBackingCache();
    const cache = new MemoryLayeredExportCache(backing, 25);
    await cache.set('a', bytes(10), 60);
    await cache.set('a', bytes(12), 60);
    expect(cache.size).toBe(12);
    await cache.set('huge', bytes(26), 60);
    expect(cache.size).toBe(12);
    expect(backing.store.has('huge')).toBe(true);
  });

  it('delegates build locks to the backing cache', async () => {
    const backing = new FakeBackingCache();
    const cache = new MemoryLayeredExportCache(backing, 10);
    expect(await cache.acquireBuildLock('k', 100)).toBe('owner');
    await cache.releaseBuildLock('k', 'owner');
    expect(backing.releaseBuildLock).toHaveBeenCalledWith('k', 'owner');
  });
});
