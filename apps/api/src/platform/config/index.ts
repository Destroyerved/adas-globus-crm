import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './env.schema.js';

/** The repository root (this file is five folders below it in both src/ and dist/). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * Loads the repository's `.env` into process.env, if it exists, without overriding
 * variables that are already set. Tests never load it, so they stay reproducible.
 * Call once at the start of each entry point (API, migrate, seed).
 */
export function loadDotEnv(): void {
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) return;
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * Resolves a `*_FILE` setting. Absolute paths (production mounts) are used as given;
 * relative ones are read from the repository root, where `.env` and `secrets/` live, so
 * the API, the worker and the scripts find the same file whichever folder they start in.
 */
export function resolveConfigPath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
}
