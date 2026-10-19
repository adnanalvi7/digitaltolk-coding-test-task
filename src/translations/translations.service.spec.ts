import { CatalogTransaction } from '../catalog-events/catalog-transaction';
import {
  DomainValidationError,
  InvalidCursorError,
  TranslationKeyNotFoundError,
} from '../common/errors/errors';
import { encodeCursor } from '../common/pagination/cursor';
import type { DbExecutor } from '../database/transaction-runner';
import type { LocaleDirectory } from '../locales/locale-directory';
import type { LocaleRepository } from '../locales/locale.repository';
import type { TagRepository } from '../tags/tag.repository';
import type { TranslationQueryRepository } from './translation-query.repository';
import { TagMatchMode, type TranslationKeyView } from './translation.model';
import type { TranslationRepository } from './translation.repository';
import { TranslationsService } from './translations.service';

const trx = { isTransaction: true } as unknown as DbExecutor;
const view = (id: string): TranslationKeyView => ({
  id,
  key: `k.${id}`,
  description: null,
  values: { en: 'x' },
  tags: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/** Runs work on a fake transaction and counts commits (= version bumps). */
class FakeCatalogTransaction extends CatalogTransaction {
  commits = 0;
  opened = 0;

  async run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T> {
    this.opened += 1;
    const result = await work(trx);
    this.commits += 1;
    return result;
  }
}

function setup() {
  const catalog = new FakeCatalogTransaction();
  const writes: jest.Mocked<TranslationRepository> = {
    insertKey: jest.fn().mockResolvedValue('10'),
    touchKey: jest.fn().mockResolvedValue(true),
    deleteKey: jest.fn().mockResolvedValue(true),
    upsertValues: jest.fn(),
    deleteValues: jest.fn(),
    replaceTags: jest.fn(),
  };
  const reads: jest.Mocked<TranslationQueryRepository> = {
    findById: jest.fn().mockResolvedValue(view('10')),
    search: jest.fn(),
  };
  const tags: jest.Mocked<TagRepository> = {
    findAll: jest.fn(),
    ensure: jest.fn().mockResolvedValue([3, 4]),
  };
  const locales = {
    resolveActive: jest.fn((codes: readonly string[]) =>
      Promise.resolve(
        new Map(
          codes
            .filter((c) => ['en', 'fr', 'es'].includes(c))
            .map((c, i) => [c, i + 1] as [string, number]),
        ),
      ),
    ),
  } as unknown as jest.Mocked<LocaleDirectory>;
  const localeRows = {
    lockActive: jest.fn((_executor: DbExecutor, ids: readonly number[]) =>
      Promise.resolve([...ids]),
    ),
  } as unknown as jest.Mocked<LocaleRepository>;
  const service = new TranslationsService(catalog, writes, reads, tags, locales, localeRows);
  return { service, catalog, writes, reads, tags, localeRows };
}

const createCommand = (values: [string, string][] = [['en', 'x']]) => ({
  key: 'a',
  description: null,
  values: new Map(values),
  tags: [] as string[],
});

describe('TranslationsService', () => {
  describe('create', () => {
    it('writes key, values and tags in one catalog transaction', async () => {
      const { service, catalog, writes, tags, localeRows } = setup();
      const result = await service.create({
        key: 'a.b',
        description: 'd',
        values: new Map([
          ['en', 'Hello'],
          ['fr', 'Bonjour'],
        ]),
        tags: ['web', 'mobile'],
      });

      expect(localeRows.lockActive).toHaveBeenCalledWith(trx, [1, 2]);
      expect(writes.insertKey).toHaveBeenCalledWith(trx, 'a.b', 'd');
      expect(writes.upsertValues).toHaveBeenCalledWith(trx, '10', [
        { localeId: 1, value: 'Hello' },
        { localeId: 2, value: 'Bonjour' },
      ]);
      expect(tags.ensure).toHaveBeenCalledWith(trx, ['web', 'mobile']);
      expect(writes.replaceTags).toHaveBeenCalledWith(trx, '10', [3, 4]);
      expect(catalog.commits).toBe(1);
      expect(result.id).toBe('10');
    });

    it('skips tag work when no tags are given', async () => {
      const { service, tags, writes } = setup();
      await service.create(createCommand());
      expect(tags.ensure).not.toHaveBeenCalled();
      expect(writes.replaceTags).not.toHaveBeenCalled();
    });

    it('rejects unknown or inactive locales before opening a transaction', async () => {
      const { service, catalog } = setup();
      await expect(
        service.create(
          createCommand([
            ['en', 'x'],
            ['zz', 'y'],
          ]),
        ),
      ).rejects.toThrow(DomainValidationError);
      expect(catalog.opened).toBe(0);
    });

    it('rejects a locale deactivated between validation and the write (in-transaction check)', async () => {
      const { service, catalog, localeRows, writes } = setup();
      localeRows.lockActive.mockResolvedValue([]);
      await expect(service.create(createCommand())).rejects.toThrow(DomainValidationError);
      expect(writes.insertKey).not.toHaveBeenCalled();
      expect(catalog.commits).toBe(0);
    });

    it('never commits (so never bumps the version) when the work fails', async () => {
      const { service, catalog, writes } = setup();
      writes.upsertValues.mockRejectedValue(new Error('constraint violated'));
      await expect(service.create(createCommand())).rejects.toThrow('constraint violated');
      expect(catalog.commits).toBe(0);
    });
  });

  describe('update', () => {
    it('upserts strings, deletes nulls and replaces tags in one catalog transaction', async () => {
      const { service, catalog, writes } = setup();
      await service.update({
        id: '10',
        description: undefined,
        values: new Map<string, string | null>([
          ['en', 'New'],
          ['fr', null],
        ]),
        tags: [],
      });
      expect(writes.touchKey).toHaveBeenCalledWith(trx, '10', undefined);
      expect(writes.upsertValues).toHaveBeenCalledWith(trx, '10', [{ localeId: 1, value: 'New' }]);
      expect(writes.deleteValues).toHaveBeenCalledWith(trx, '10', [2]);
      expect(writes.replaceTags).toHaveBeenCalledWith(trx, '10', [3, 4]);
      expect(catalog.commits).toBe(1);
    });

    it('leaves tags untouched when not provided and skips locale locking without upserts', async () => {
      const { service, writes, localeRows } = setup();
      await service.update({ id: '10', description: 'x', values: undefined, tags: undefined });
      expect(writes.replaceTags).not.toHaveBeenCalled();
      expect(localeRows.lockActive).not.toHaveBeenCalled();
    });

    it('throws not found inside the transaction for a missing key', async () => {
      const { service, catalog, writes } = setup();
      writes.touchKey.mockResolvedValue(false);
      await expect(
        service.update({ id: '99', description: undefined, values: undefined, tags: undefined }),
      ).rejects.toThrow(TranslationKeyNotFoundError);
      expect(catalog.commits).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes in a catalog transaction', async () => {
      const { service, catalog } = setup();
      await service.delete('10');
      expect(catalog.commits).toBe(1);
    });

    it('throws not found for a missing key without committing', async () => {
      const { service, catalog, writes } = setup();
      writes.deleteKey.mockResolvedValue(false);
      await expect(service.delete('99')).rejects.toThrow(TranslationKeyNotFoundError);
      expect(catalog.commits).toBe(0);
    });
  });

  describe('get', () => {
    it('throws not found for a missing key', async () => {
      const { service, reads } = setup();
      reads.findById.mockResolvedValue(undefined);
      await expect(service.get('1')).rejects.toThrow(TranslationKeyNotFoundError);
    });
  });

  describe('search', () => {
    it('decodes the cursor and returns the next cursor when there are more rows', async () => {
      const { service, reads } = setup();
      reads.search.mockResolvedValue({ items: [view('5'), view('6')], hasMore: true });
      const page = await service.search({
        keyPrefix: 'a.',
        text: undefined,
        tags: { names: ['web'], mode: TagMatchMode.All },
        localeCode: 'en',
        cursor: encodeCursor('4'),
        limit: 2,
      });
      expect(reads.search).toHaveBeenCalledWith(
        expect.objectContaining({ afterId: '4', limit: 2 }),
      );
      expect(page.nextCursor).toBe(encodeCursor('6'));
    });

    it('returns a null cursor on the last page', async () => {
      const { service, reads } = setup();
      reads.search.mockResolvedValue({ items: [view('5')], hasMore: false });
      const page = await service.search({
        keyPrefix: undefined,
        text: undefined,
        tags: undefined,
        localeCode: undefined,
        cursor: undefined,
        limit: 2,
      });
      expect(page.nextCursor).toBeNull();
    });

    it('rejects a tampered cursor', async () => {
      const { service } = setup();
      await expect(
        service.search({
          keyPrefix: undefined,
          text: undefined,
          tags: undefined,
          localeCode: undefined,
          cursor: 'garbage!',
          limit: 2,
        }),
      ).rejects.toThrow(InvalidCursorError);
    });
  });
});
