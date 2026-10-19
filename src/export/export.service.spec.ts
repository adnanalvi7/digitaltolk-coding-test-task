import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { VersionStore } from '../catalog-events/version-store';
import type { AppConfig } from '../config/app-config';
import { LocaleNotFoundError } from '../common/errors/errors';
import type { LocaleDirectory } from '../locales/locale-directory';
import type { ExportCache } from './export-cache';
import { exportCacheKey, weakEtag } from './export-keys';
import type { ExportRepository } from './export.repository';
import { type ExportRequest, ExportService } from './export.service';
import { ExportFormat } from './formatters/export-formatter';
import { ExportFormatterRegistry } from './formatters/export-formatter.registry';
import { FlatExportFormatter } from './formatters/flat-export.formatter';
import { NestedExportFormatter } from './formatters/nested-export.formatter';

const SETTINGS: AppConfig['export'] = {
  public: false,
  cacheTtlSeconds: 60,
  sMaxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 30,
  warmOnChange: false,
  buildLockMs: 10_000,
  lockWaitMs: 120,
  sideEffectDebounceMs: 1,
  memoryCacheBytes: 1_000_000,
};
const EN = {
  id: 1,
  code: 'en',
  name: 'English',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup() {
  const versions: jest.Mocked<VersionStore> = {
    current: jest.fn().mockResolvedValue(3),
    publish: jest.fn(),
    peek: jest.fn(),
    replaceIf: jest.fn(),
  };
  const locales = {
    findActive: jest.fn().mockResolvedValue(EN),
    listActive: jest.fn().mockResolvedValue([EN]),
  } as unknown as jest.Mocked<LocaleDirectory>;
  const repository: jest.Mocked<ExportRepository> = {
    fetchEntries: jest.fn().mockResolvedValue([
      { key: 'a.b', value: 'B' },
      { key: 'a.c', value: 'C' },
    ]),
  };
  const store = new Map<string, Buffer>();
  const cache: jest.Mocked<ExportCache> = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: Buffer, _ttlSeconds: number) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    acquireBuildLock: jest.fn().mockResolvedValue('owner-1'),
    releaseBuildLock: jest.fn(),
  };
  const registry = new ExportFormatterRegistry([
    new FlatExportFormatter(),
    new NestedExportFormatter(),
  ]);
  const config = { get: () => SETTINGS } as unknown as ConfigService<AppConfig, true>;
  const service = new ExportService(versions, locales, repository, cache, registry, config);
  return { service, versions, locales, repository, cache, store };
}

const request = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  localeCode: 'en',
  format: ExportFormat.Flat,
  tags: undefined,
  ifNoneMatch: undefined,
  acceptsGzip: true,
  ...overrides,
});

const body = (result: Awaited<ReturnType<ExportService['export']>>): unknown => {
  if (result.kind !== 'document') throw new Error('expected a document');
  const raw = result.encoding === 'gzip' ? gunzipSync(result.body) : result.body;
  return JSON.parse(raw.toString('utf8'));
};

describe('ExportService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds on a cold miss: one query, cache the gzip, release the lock', async () => {
    const { service, repository, cache, store } = setup();
    const result = await service.export(request());

    expect(body(result)).toEqual({ 'a.b': 'B', 'a.c': 'C' });
    expect(result).toMatchObject({ kind: 'document', encoding: 'gzip' });
    expect(repository.fetchEntries).toHaveBeenCalledTimes(1);
    expect(store.has('export:en:flat:all:v3')).toBe(true);
    expect(cache.releaseBuildLock).toHaveBeenCalledWith('export:en:flat:all:v3', 'owner-1');
  });

  it('serves warm hits from cache without touching the repository', async () => {
    const { service, repository } = setup();
    await service.export(request());
    await service.export(request());
    expect(repository.fetchEntries).toHaveBeenCalledTimes(1);
  });

  it('returns 304 on a matching ETag without reading the payload', async () => {
    const { service, cache, repository } = setup();
    const etag = weakEtag(exportCacheKey('en', ExportFormat.Flat, undefined, 3));
    const result = await service.export(request({ ifNoneMatch: etag }));
    expect(result).toEqual({ kind: 'not-modified', etag });
    expect(cache.get).not.toHaveBeenCalled();
    expect(repository.fetchEntries).not.toHaveBeenCalled();
  });

  it('changes the ETag when the catalog version changes (freshness)', async () => {
    const { service, versions } = setup();
    const first = await service.export(request());
    versions.current.mockResolvedValue(4);
    const second = await service.export(request());
    expect(first.etag).not.toBe(second.etag);
  });

  it('decompresses for clients that do not accept gzip', async () => {
    const { service } = setup();
    const result = await service.export(request({ acceptsGzip: false }));
    expect(result).toMatchObject({ kind: 'document', encoding: 'identity' });
    expect(body(result)).toEqual({ 'a.b': 'B', 'a.c': 'C' });
  });

  it('renders the nested format', async () => {
    const { service } = setup();
    expect(body(await service.export(request({ format: ExportFormat.Nested })))).toEqual({
      a: { b: 'B', c: 'C' },
    });
  });

  it('404s for unknown or inactive locales, checking against the current version', async () => {
    const { service, locales } = setup();
    locales.findActive.mockResolvedValue(undefined);
    await expect(service.export(request({ localeCode: 'zz' }))).rejects.toThrow(
      LocaleNotFoundError,
    );
    expect(locales.findActive).toHaveBeenCalledWith('zz', 3);
  });

  it('coalesces concurrent cold builds in-process', async () => {
    const { service, repository } = setup();
    await Promise.all([
      service.export(request()),
      service.export(request()),
      service.export(request()),
    ]);
    expect(repository.fetchEntries).toHaveBeenCalledTimes(1);
  });

  it('waits for another instance holding the build lock, then uses its result', async () => {
    const { service, cache, repository, store } = setup();
    cache.acquireBuildLock.mockResolvedValue(null);
    setTimeout(() => store.set('export:en:flat:all:v3', gzipSync('{"built":"elsewhere"}')), 30);
    expect(body(await service.export(request()))).toEqual({ built: 'elsewhere' });
    expect(repository.fetchEntries).not.toHaveBeenCalled();
    expect(cache.releaseBuildLock).not.toHaveBeenCalled();
  });

  it('builds itself if the lock holder never delivers', async () => {
    const { service, cache, repository } = setup();
    cache.acquireBuildLock.mockResolvedValue(null);
    await service.export(request());
    expect(repository.fetchEntries).toHaveBeenCalledTimes(1);
  });

  it('degrades to an uncached, ETag-less build when the version store is down', async () => {
    const { service, versions, cache } = setup();
    versions.current.mockRejectedValue(new Error('redis down'));
    const result = await service.export(request());
    expect(result).toMatchObject({ kind: 'document', etag: undefined });
    expect(body(result)).toEqual({ 'a.b': 'B', 'a.c': 'C' });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('logs degraded mode once per state change, not once per request', async () => {
    const info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, versions } = setup();
    versions.current.mockRejectedValue(new Error('redis down'));
    await service.export(request());
    await service.export(request());
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);

    versions.current.mockResolvedValue(3);
    await service.export(request());
    await service.export(request());
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('warms every active locale in each requested format', async () => {
    const { service, store } = setup();
    await service.warm([ExportFormat.Flat, ExportFormat.Nested]);
    expect([...store.keys()].sort()).toEqual(['export:en:flat:all:v3', 'export:en:nested:all:v3']);
  });
});
