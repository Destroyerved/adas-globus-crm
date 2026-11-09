/**
 * API server for end-to-end tests only. Same code as the real API, but on a throw-away test
 * database: real PostgreSQL when TEST_DATABASE_URL is set, otherwise in-memory PGlite
 * (AGENTS.md section 5 allows PGlite in tests only). Never use this to run the CRM.
 *
 *   pnpm --filter @adas/api start:e2e
 */
import { createAppServer } from './main.js';
import { ImportProcessor } from './modules/imports/index.js';
import { validateEnv } from './platform/config/index.js';
import { SecretBox } from './platform/crypto/index.js';
import { DatabaseService } from './platform/db/index.js';
import { MemoryFileStorage } from './platform/files/index.js';

const env = validateEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn' });
const files = new MemoryFileStorage();
const { server, db, logger, services } = createAppServer(env, DatabaseService.forTests(), {
  secretBox: SecretBox.ephemeral(),
  files,
});
await db.ensureInitialized();

// The import job, in-process on the same test database. The real worker runs the same
// ImportProcessor through pg-boss (jobs.ts; tested in m1-worker and m2-imports).
const imports = new ImportProcessor(
  db,
  files,
  (userId) => services.auth.resolveSessionUser(userId),
  logger,
);
let importBusy = false;
setInterval(() => {
  if (importBusy) return;
  importBusy = true;
  void imports
    .processNext()
    .catch((err: Error) => logger.error({ err: err.name }, 'e2e import job failed'))
    .finally(() => {
      importBusy = false;
    });
}, 500).unref();

// The duplicate scan, in-process and more often than the worker's once a minute so the
// duplicates test need not wait. The worker runs the same DuplicateService.scan (jobs.ts).
let scanBusy = false;
setInterval(() => {
  if (scanBusy) return;
  scanBusy = true;
  void services.duplicates
    .scan({ budgetMs: 2_000 })
    .catch((err: Error) => logger.error({ err: err.name }, 'e2e duplicate scan failed'))
    .finally(() => {
      scanBusy = false;
    });
}, 1_000).unref();

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
