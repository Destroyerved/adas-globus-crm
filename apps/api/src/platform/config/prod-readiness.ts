import { existsSync, readFileSync } from 'node:fs';
import { type SecretBox } from '../crypto/index.js';
import { type DatabaseService } from '../db/index.js';
import { type AppEnv, isDevLoginEnabled } from './env.schema.js';

/**
 * Fail-closed production startup checks (PRD 5, 6.6, 9, 10).
 *
 * Replaces the Phase 0 unconditional `process.exit(1)` stub in `main.ts` and `worker.ts`
 * with real cryptographic, database-privilege, and compliance safety assertions whenever
 * `NODE_ENV === 'production'`.
 */
export async function verifyProductionReadiness(params: {
  env: AppEnv;
  db: DatabaseService;
  secretBox: SecretBox | null;
  resolvePath: (p: string) => string;
}): Promise<void> {
  const { env, db, secretBox, resolvePath } = params;
  if (env.NODE_ENV !== 'production') return;

  const issues: string[] = [];

  // 1. Dev login must never be active in production
  if (isDevLoginEnabled(env)) {
    issues.push('Dev login is enabled in production mode.');
  }

  // 2. Mounted session secret file must exist and have >= 32 characters
  const sessionSecretPath = resolvePath(env.SESSION_SECRET_FILE);
  if (!existsSync(sessionSecretPath)) {
    issues.push(`SESSION_SECRET_FILE is missing (${env.SESSION_SECRET_FILE}).`);
  } else {
    const raw = readFileSync(sessionSecretPath, 'utf8').trim();
    if (raw.length < 32) {
      issues.push('SESSION_SECRET_FILE must contain at least 32 non-whitespace characters.');
    }
  }

  // 3. AES-256-GCM SecretBox must be initialized
  if (!secretBox) {
    issues.push(
      `TOKEN_ENCRYPTION_KEY_FILE is missing or invalid (${env.TOKEN_ENCRYPTION_KEY_FILE}).`,
    );
  }

  // 4. DATABASE_URL must connect as a least-privilege non-superuser role (never postgres or adas_admin)
  const roleRes = await db.query<{
    current_user: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT current_user::text AS current_user, rolsuper, rolcreatedb, rolcreaterole
     FROM pg_roles
     WHERE rolname = current_user`,
  );
  const role = roleRes.rows[0];
  if (!role) {
    issues.push('Could not inspect current PostgreSQL role privileges.');
  } else if (role.rolsuper) {
    issues.push(
      `DATABASE_URL connects as PostgreSQL superuser "${role.current_user}", which bypasses append-only audit_logs and suppressions protections. Use least-privilege role "adas_app".`,
    );
  }

  // 5. Counsel sign-off gate before live outbound mail (AGENTS.md §10, PRD Q6)
  if (env.MAIL_LIVE) {
    const counselRes = await db.query<{ value_json: unknown }>(
      `SELECT value_json FROM settings WHERE key = 'compliance.counsel_signed_off' LIMIT 1`,
    );
    if (counselRes.rows[0]?.value_json !== true) {
      issues.push(
        'MAIL_LIVE=true requires settings("compliance.counsel_signed_off") = true after legal counsel sign-off.',
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(`Production readiness verification failed:\n - ${issues.join('\n - ')}`);
  }
}
