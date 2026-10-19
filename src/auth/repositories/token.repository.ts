import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb } from '../../database/database.tokens';
import type { Database } from '../../database/kysely.factory';

export interface StoredToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface InsertTokenCommand {
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export abstract class TokenRepository {
  abstract insert(command: InsertTokenCommand): Promise<string>;
  abstract findByHash(tokenHash: string): Promise<StoredToken | undefined>;
  abstract revoke(tokenId: string, at: Date): Promise<void>;
  /** Writes `last_used_at` only if the stored value is older than `staleBefore`. */
  abstract touchLastUsed(tokenId: string, at: Date, staleBefore: Date): Promise<void>;
}

@Injectable()
export class KyselyTokenRepository extends TokenRepository {
  constructor(@InjectDb() private readonly db: Database) {
    super();
  }

  async insert(command: InsertTokenCommand): Promise<string> {
    const row = await this.db
      .insertInto('api_tokens')
      .values({
        user_id: command.userId,
        name: command.name,
        token_hash: command.tokenHash,
        scopes: [...command.scopes],
        expires_at: command.expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async findByHash(tokenHash: string): Promise<StoredToken | undefined> {
    const row = await this.db
      .selectFrom('api_tokens')
      .select(['id', 'user_id', 'token_hash', 'scopes', 'expires_at', 'revoked_at', 'last_used_at'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at,
      }
    );
  }

  async revoke(tokenId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('api_tokens')
      .set({ revoked_at: at })
      .where('id', '=', tokenId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async touchLastUsed(tokenId: string, at: Date, staleBefore: Date): Promise<void> {
    await this.db
      .updateTable('api_tokens')
      .set({ last_used_at: at })
      .where('id', '=', tokenId)
      .where(sql<boolean>`coalesce(last_used_at < ${staleBefore}, true)`)
      .execute();
  }
}
