/**
 * API server for end-to-end tests only. Same code as the real API, but on a throw-away test
 * database: real PostgreSQL when TEST_DATABASE_URL is set, otherwise in-memory PGlite
 * (AGENTS.md section 5 allows PGlite in tests only). Never use this to run the CRM.
 *
 *   pnpm --filter @adas/api start:e2e
 */
import { createAppServer } from './main.js';
import { validateEnv } from './platform/config/index.js';
import { DatabaseService } from './platform/db/index.js';

const env = validateEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn' });
const { server, db, logger } = createAppServer(env, DatabaseService.forTests());
await db.ensureInitialized();
server.listen(env.PORT, () => {
  logger.warn({ port: env.PORT }, 'E2E test API listening on a throw-away test database');
});
