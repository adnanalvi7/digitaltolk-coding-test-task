import { Injectable } from '@nestjs/common';
import { InjectDb } from './database.tokens';
import type { Database } from './kysely.factory';

/**
 * Query executor handed to repositories: the root Kysely instance or an open
 * transaction (Kysely's Transaction extends Kysely, so they share one type).
 */
export type DbExecutor = Database;

/** Unit-of-work port: services own transaction boundaries without importing Kysely. */
export abstract class TransactionRunner {
  abstract run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T>;
}

@Injectable()
export class KyselyTransactionRunner extends TransactionRunner {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  run<T>(work: (executor: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}
