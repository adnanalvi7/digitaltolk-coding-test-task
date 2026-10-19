import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env` from the working directory when present (local development).
 * Real environment variables always win; containers inject env directly.
 */
export function loadDotEnv(file = resolve(process.cwd(), '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
