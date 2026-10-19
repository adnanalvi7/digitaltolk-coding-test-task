import { CatalogTransaction } from '../catalog-events/catalog-transaction';
import type { VersionStore } from '../catalog-events/version-store';
import type { DbExecutor } from '../database/transaction-runner';
import type { Clock } from '../common/clock';
import { LocaleNotFoundError } from '../common/errors/errors';
import { LOCALE_CACHE_TTL_MS, LocaleDirectory, MISS_RELOAD_INTERVAL_MS } from './locale-directory';
import type { LocaleRecord, LocaleRepository } from './locale.repository';
import { LocalesService } from './locales.service';

const at = new Date('2026-01-01T00:00:00Z');
const locale = (id: number, code: string, isActive = true): LocaleRecord => ({
  id,
  code,
  name: code,
  isActive,
  createdAt: at,
  updatedAt: at,
});

function setup(rows: LocaleRecord[] = [locale(1, 'en'), locale(2, 'fr'), locale(3, 'xx', false)]) {
  let now = at.getTime();
  const clock: Clock = { now: () => new Date(now) };
  const repository: jest.Mocked<LocaleRepository> = {
    findAll: jest.fn().mockResolvedValue(rows),
    create: jest.fn(),
    update: jest.fn(),
    lockActive: jest.fn(),
  };
  const versions: jest.Mocked<VersionStore> = {
    current: jest.fn().mockResolvedValue(5),
    publish: jest.fn(),
    peek: jest.fn(),
    replaceIf: jest.fn(),
  };
  const directory = new LocaleDirectory(repository, versions, clock);
  return {
    directory,
    repository,
    versions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('LocaleDirectory', () => {
  it('serves active locales from memory after one load', async () => {
    const { directory, repository } = setup();
    expect(await directory.findActive('en')).toMatchObject({ id: 1 });
    expect(await directory.findActive('fr')).toMatchObject({ id: 2 });
    expect(repository.findAll).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent loads into one query', async () => {
    const { directory, repository } = setup();
    await Promise.all([directory.findActive('en'), directory.findActive('fr')]);
    expect(repository.findAll).toHaveBeenCalledTimes(1);
  });

  it('treats inactive locales as missing', async () => {
    const { directory } = setup();
    expect(await directory.findActive('xx')).toBeUndefined();
    expect(await directory.listActive()).toHaveLength(2);
  });

  it('reloads when the snapshot is older than the caller-known catalog version', async () => {
    const { directory, repository, versions } = setup();
    await directory.findActive('en', 5);
    versions.current.mockResolvedValue(6);
    await directory.findActive('en', 6);
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });

  it('reloads after the TTL', async () => {
    const { directory, repository, advance } = setup();
    await directory.findActive('en');
    advance(LOCALE_CACHE_TTL_MS);
    await directory.findActive('en');
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });

  it('reloads on a miss, but at most once per interval', async () => {
    const { directory, repository, advance } = setup();
    await directory.findActive('en');
    await directory.findActive('de');
    expect(repository.findAll).toHaveBeenCalledTimes(1);

    advance(MISS_RELOAD_INTERVAL_MS);
    repository.findAll.mockResolvedValue([locale(1, 'en'), locale(4, 'de')]);
    expect(await directory.findActive('de')).toMatchObject({ id: 4 });
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });

  it('resolves codes to ids, omitting unknown or inactive ones', async () => {
    const { directory, advance } = setup();
    expect([...(await directory.resolveActive(['en', 'fr']))]).toEqual([
      ['en', 1],
      ['fr', 2],
    ]);
    advance(MISS_RELOAD_INTERVAL_MS);
    expect([...(await directory.resolveActive(['en', 'xx', 'zz']))]).toEqual([['en', 1]]);
  });

  it('reloads after invalidate()', async () => {
    const { directory, repository } = setup();
    await directory.findActive('en');
    directory.invalidate();
    await directory.findActive('en');
    expect(repository.findAll).toHaveBeenCalledTimes(2);
  });
});

describe('LocalesService', () => {
  const trx = { trx: true } as unknown as DbExecutor;

  class FakeCatalogTransaction extends CatalogTransaction {
    commits = 0;
    async run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T> {
      const result = await work(trx);
      this.commits += 1;
      return result;
    }
  }

  function service() {
    const { directory, repository } = setup();
    const catalog = new FakeCatalogTransaction();
    const invalidate = jest.spyOn(directory, 'invalidate');
    return {
      svc: new LocalesService(repository, directory, catalog),
      repository,
      catalog,
      invalidate,
    };
  }

  it('lists locales', async () => {
    const { svc } = service();
    expect(await svc.list()).toHaveLength(3);
  });

  it('creates a locale in a catalog transaction, then invalidates the cache', async () => {
    const { svc, repository, catalog, invalidate } = service();
    repository.create.mockResolvedValue(locale(9, 'pt-BR'));
    await svc.create({ code: 'pt-BR', name: 'Português', isActive: true });
    expect(repository.create).toHaveBeenCalledWith(trx, expect.objectContaining({ code: 'pt-BR' }));
    expect(catalog.commits).toBe(1);
    expect(invalidate).toHaveBeenCalled();
  });

  it('updates a locale in a catalog transaction', async () => {
    const { svc, repository, catalog } = service();
    repository.update.mockResolvedValue(locale(2, 'fr', false));
    expect(await svc.update('fr', { name: undefined, isActive: false })).toMatchObject({
      isActive: false,
    });
    expect(catalog.commits).toBe(1);
  });

  it('throws LocaleNotFoundError inside the transaction, so nothing commits', async () => {
    const { svc, repository, catalog } = service();
    repository.update.mockResolvedValue(undefined);
    await expect(svc.update('zz', { name: 'x', isActive: undefined })).rejects.toThrow(
      LocaleNotFoundError,
    );
    expect(catalog.commits).toBe(0);
  });
});
