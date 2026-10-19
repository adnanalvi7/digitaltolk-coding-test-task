import {
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { KyselyPlugin } from 'kysely';
import type { AppConfig } from '../config/app-config';
import { InjectDb, KYSELY } from './database.tokens';
import { type Database, createKysely } from './kysely.factory';
import { KyselyTransactionRunner, TransactionRunner } from './transaction-runner';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

export interface DatabaseModuleOptions {
  readonly db: AppConfig['db'];
  /** Extra Kysely plugins, e.g. a query counter in tests. */
  readonly plugins?: readonly KyselyPlugin[];
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: KYSELY,
          useFactory: (): Database => createKysely(options.db, { plugins: options.plugins ?? [] }),
        },
        DatabaseLifecycle,
        { provide: TransactionRunner, useClass: KyselyTransactionRunner },
      ],
      exports: [KYSELY, TransactionRunner],
    };
  }
}
