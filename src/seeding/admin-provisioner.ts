import type { PasswordHasher } from '../auth/password-hasher';
import type { UserRepository } from '../auth/repositories/user.repository';
import { ALL_TOKEN_SCOPES } from '../auth/token-scope';

/**
 * Creates or updates the admin user from ADMIN_EMAIL / ADMIN_PASSWORD.
 * Credentials are never hard-coded; without them, nothing is provisioned.
 */
export async function provisionAdmin(
  users: UserRepository,
  passwords: PasswordHasher,
  credentials: { email: string | undefined; password: string | undefined },
): Promise<string | undefined> {
  if (credentials.email === undefined || credentials.password === undefined) return undefined;
  await users.upsert({
    email: credentials.email,
    passwordHash: await passwords.hash(credentials.password),
    scopes: ALL_TOKEN_SCOPES,
  });
  return credentials.email;
}
