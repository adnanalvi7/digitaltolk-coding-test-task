import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>;
  abstract verify(hash: string, password: string): Promise<boolean>;
  /**
   * Burns the same CPU as a real verification. Called for unknown emails so
   * response timing does not reveal whether an account exists.
   */
  abstract verifyAgainstDummy(password: string): Promise<void>;
}

/** OWASP-recommended argon2id baseline (19 MiB, t=2, p=1). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, password);
  }
}
