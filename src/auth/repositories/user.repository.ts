import { Injectable } from '@nestjs/common';
import { InjectDb } from '../../database/database.tokens';
import type { Database } from '../../database/kysely.factory';

export interface UserCredentials {
  readonly id: string;
  readonly passwordHash: string;
  readonly scopes: readonly string[];
}

export interface UpsertUserCommand {
  readonly email: string;
  readonly passwordHash: string;
  readonly scopes: readonly string[];
}

export abstract class UserRepository {
  abstract findCredentialsByEmail(email: string): Promise<UserCredentials | undefined>;
  abstract upsert(command: UpsertUserCommand): Promise<string>;
}

@Injectable()
export class KyselyUserRepository extends UserRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  async findCredentialsByEmail(email: string): Promise<UserCredentials | undefined> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'scopes'])
      .where('email', '=', email)
      .executeTakeFirst();
    return row && { id: row.id, passwordHash: row.password_hash, scopes: row.scopes };
  }

  async upsert({ email, passwordHash, scopes }: UpsertUserCommand): Promise<string> {
    const row = await this.db
      .insertInto('users')
      .values({ email, password_hash: passwordHash, scopes: [...scopes] })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet((eb) => ({
          password_hash: eb.ref('excluded.password_hash'),
          scopes: eb.ref('excluded.scopes'),
        })),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
