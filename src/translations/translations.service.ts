import { Injectable } from '@nestjs/common';
import { CatalogTransaction } from '../catalog-events/catalog-transaction';
import { DomainValidationError, TranslationKeyNotFoundError } from '../common/errors/errors';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import type { DbExecutor } from '../database/transaction-runner';
import { LocaleDirectory } from '../locales/locale-directory';
import { LocaleRepository } from '../locales/locale.repository';
import { TagRepository } from '../tags/tag.repository';
import { TranslationQueryRepository } from './translation-query.repository';
import { type LocaleValue, TranslationRepository } from './translation.repository';
import type {
  CreateTranslationCommand,
  SearchTranslationsQuery,
  TranslationKeyView,
  TranslationPage,
  UpdateTranslationCommand,
} from './translation.model';

interface ResolvedValue<V> {
  readonly localeId: number;
  readonly value: V;
}

@Injectable()
export class TranslationsService {
  constructor(
    private readonly catalog: CatalogTransaction,
    private readonly writes: TranslationRepository,
    private readonly reads: TranslationQueryRepository,
    private readonly tags: TagRepository,
    private readonly locales: LocaleDirectory,
    private readonly localeRows: LocaleRepository,
  ) {}

  async search(query: SearchTranslationsQuery): Promise<TranslationPage> {
    const { items, hasMore } = await this.reads.search({
      keyPrefix: query.keyPrefix,
      text: query.text,
      tags: query.tags,
      localeCode: query.localeCode,
      afterId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit: query.limit,
    });
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  async get(id: string): Promise<TranslationKeyView> {
    const view = await this.reads.findById(id);
    if (!view) throw new TranslationKeyNotFoundError(id);
    return view;
  }

  async create(command: CreateTranslationCommand): Promise<TranslationKeyView> {
    const values = await this.resolveLocales([...command.values]);

    const id = await this.catalog.run(async (trx) => {
      await this.lockActiveLocales(trx, values);
      const keyId = await this.writes.insertKey(trx, command.key, command.description);
      await this.writes.upsertValues(trx, keyId, values);
      if (command.tags.length > 0) {
        await this.writes.replaceTags(trx, keyId, await this.tags.ensure(trx, command.tags));
      }
      return keyId;
    });
    return this.get(id);
  }

  async update(command: UpdateTranslationCommand): Promise<TranslationKeyView> {
    const changes = await this.resolveLocales([...(command.values ?? [])]);
    const upserts: LocaleValue[] = [];
    const removals: number[] = [];
    for (const { localeId, value } of changes) {
      if (value === null) removals.push(localeId);
      else upserts.push({ localeId, value });
    }

    await this.catalog.run(async (trx) => {
      const exists = await this.writes.touchKey(trx, command.id, command.description);
      if (!exists) throw new TranslationKeyNotFoundError(command.id);
      await this.lockActiveLocales(trx, upserts);
      await this.writes.upsertValues(trx, command.id, upserts);
      await this.writes.deleteValues(trx, command.id, removals);
      if (command.tags !== undefined) {
        await this.writes.replaceTags(trx, command.id, await this.tags.ensure(trx, command.tags));
      }
    });
    return this.get(command.id);
  }

  /** A missing key throws inside the transaction, so a 404 never advances the version. */
  async delete(id: string): Promise<void> {
    await this.catalog.run(async (trx) => {
      if (!(await this.writes.deleteKey(trx, id))) throw new TranslationKeyNotFoundError(id);
    });
  }

  /** Fast, cache-backed check before opening a transaction. */
  private async resolveLocales<V>(
    entries: readonly (readonly [string, V])[],
  ): Promise<ResolvedValue<V>[]> {
    const ids = await this.locales.resolveActive(entries.map(([code]) => code));
    const resolved: ResolvedValue<V>[] = [];
    const missing: string[] = [];
    for (const [code, value] of entries) {
      const localeId = ids.get(code);
      if (localeId === undefined) missing.push(code);
      else resolved.push({ localeId, value });
    }
    if (missing.length > 0) throw unknownLocales(missing);
    return resolved;
  }

  /**
   * Authoritative re-check inside the transaction: `FOR SHARE` both confirms
   * the locales are still active and blocks a concurrent deactivation until
   * this write commits (closes the check-then-write race).
   */
  private async lockActiveLocales(
    executor: DbExecutor,
    values: readonly ResolvedValue<unknown>[],
  ): Promise<void> {
    const wanted = [...new Set(values.map((value) => value.localeId))];
    if (wanted.length === 0) return;
    const active = new Set(await this.localeRows.lockActive(executor, wanted));
    const inactive = wanted.filter((id) => !active.has(id));
    if (inactive.length > 0) throw unknownLocales(inactive.map(String));
  }
}

function unknownLocales(codes: readonly string[]): DomainValidationError {
  return new DomainValidationError(
    codes.map((code) => ({ field: `values.${code}`, message: 'unknown or inactive locale' })),
  );
}
