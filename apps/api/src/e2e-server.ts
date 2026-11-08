/**
 * API server for end-to-end tests only. Same code as the real API, but on a throw-away test
 * database: real PostgreSQL when TEST_DATABASE_URL is set, otherwise in-memory PGlite
 * (AGENTS.md section 5 allows PGlite in tests only). Never use this to run the CRM.
 *
 *   pnpm --filter @adas/api start:e2e
 */
import { createAppServer } from './main.js';
import { validateEnv } from './platform/config/index.js';
import { SecretBox } from './platform/crypto/index.js';
import { DatabaseService } from './platform/db/index.js';

const env = validateEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn' });
const { server, db, logger, services } = createAppServer(env, DatabaseService.forTests(), {
  secretBox: SecretBox.ephemeral(),
});
await db.ensureInitialized();

// A synthetic emergency admin for the admin sign-in test. playwright.config.ts generates its
// password and authenticator secret afresh on every run; nothing is stored in the repository.
const password = process.env['E2E_ADMIN_PASSWORD'];
const totpSecret = process.env['E2E_ADMIN_TOTP_SECRET'];
if (password && totpSecret) {
  await db.query(
    `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
     VALUES ('usr_e2e_emergency', 'emergency.admin@adasglobuspro.example.com', 'Emergency Admin',
             'role_admin', NULL, 'US', 'invited')
     ON CONFLICT (id) DO NOTHING`,
  );
  await services.breakGlass.setUp('emergency.admin@adasglobuspro.example.com', {
    password,
    totpSecret,
  });
}
server.listen(env.PORT, () => {
  logger.warn({ port: env.PORT }, 'E2E test API listening on a throw-away test database');
});
