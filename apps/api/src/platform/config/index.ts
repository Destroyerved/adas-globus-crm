import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './env.schema.js';

/**
 * Loads the repository's `.env` into process.env, if it exists, without overriding
 * variables that are already set. Tests never load it, so they stay reproducible.
 * Call once at the start of each entry point (API, migrate, seed).
 */
export function loadDotEnv(): void {
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const file = path.join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
