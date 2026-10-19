import { Injectable } from '@nestjs/common';
import { CatalogTransaction } from '../catalog-events/catalog-transaction';
import { LocaleNotFoundError } from '../common/errors/errors';
import { LocaleDirectory } from './locale-directory';
import {
  type CreateLocaleCommand,
  type LocaleRecord,
  LocaleRepository,
  type UpdateLocaleCommand,
} from './locale.repository';

@Injectable()
export class LocalesService {
  constructor(
    private readonly locales: LocaleRepository,
    private readonly directory: LocaleDirectory,
    private readonly catalog: CatalogTransaction,
  ) {}

  list(): Promise<LocaleRecord[]> {
    return this.locales.findAll();
  }

  /** Adding a language is a row insert: no migration, no deploy. */
  async create(command: CreateLocaleCommand): Promise<LocaleRecord> {
    const locale = await this.catalog.run((trx) => this.locales.create(trx, command));
    this.directory.invalidate();
    return locale;
  }

  /** An unknown code throws inside the transaction, so it never advances the version. */
  async update(code: string, command: UpdateLocaleCommand): Promise<LocaleRecord> {
    const locale = await this.catalog.run(async (trx) => {
      const updated = await this.locales.update(trx, code, command);
      if (!updated) throw new LocaleNotFoundError(code);
      return updated;
    });
    this.directory.invalidate();
    return locale;
  }
}
