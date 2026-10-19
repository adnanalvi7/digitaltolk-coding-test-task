import { Injectable } from '@nestjs/common';
import { InjectDb } from '../database/database.tokens';
import { sql } from 'kysely';
import type { Database } from '../database/kysely.factory';
import type { DbExecutor } from '../database/transaction-runner';
import { PG_UNIQUE_VIOLATION, isPgError } from '../database/pg-error';
import { LocaleAlreadyExistsError } from '../common/errors/errors';

export interface LocaleRecord {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateLocaleCommand {
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface UpdateLocaleCommand {
  readonly name: string | undefined;
  readonly isActive: boolean | undefined;
}

export abstract class LocaleRepository {
  abstract findAll(): Promise<LocaleRecord[]>;
  abstract create(executor: DbExecutor, command: CreateLocaleCommand): Promise<LocaleRecord>;
  abstract update(
    executor: DbExecutor,
    code: string,
    command: UpdateLocaleCommand,
  ): Promise<LocaleRecord | undefined>;
  /** Returns which of `ids` are active, holding a FOR SHARE lock on them until commit. */
  abstract lockActive(executor: DbExecutor, ids: readonly number[]): Promise<number[]>;
}

const COLUMNS = ['id', 'code', 'name', 'is_active', 'created_at', 'updated_at'] as const;

interface LocaleRow {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: LocaleRow): LocaleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class KyselyLocaleRepository extends LocaleRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  async findAll(): Promise<LocaleRecord[]> {
    const rows = await this.db.selectFrom('locales').select(COLUMNS).orderBy('code').execute();
    return rows.map(toRecord);
  }

  async create(executor: DbExecutor, command: CreateLocaleCommand): Promise<LocaleRecord> {
    try {
      const row = await executor
        .insertInto('locales')
        .values({ code: command.code, name: command.name, is_active: command.isActive })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (error: unknown) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) throw new LocaleAlreadyExistsError(command.code);
      throw error;
    }
  }

  async update(
    executor: DbExecutor,
    code: string,
    command: UpdateLocaleCommand,
  ): Promise<LocaleRecord | undefined> {
    const row = await executor
      .updateTable('locales')
      .set((eb) => ({
        name: command.name ?? eb.ref('name'),
        is_active: command.isActive ?? eb.ref('is_active'),
      }))
      .where('code', '=', code)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row && toRecord(row);
  }

  async lockActive(executor: DbExecutor, ids: readonly number[]): Promise<number[]> {
    const rows = await executor
      .selectFrom('locales')
      .select('id')
      .where('id', '=', sql<number>`any(${[...ids]}::smallint[])`)
      .where('is_active', '=', true)
      .forShare()
      .execute();
    return rows.map((row) => row.id);
  }
}
