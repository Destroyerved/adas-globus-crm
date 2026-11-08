/**
 * The background worker (PRD 6.9): pg-boss queues for outbox dispatch, task reminders and
 * overdue alerts, inquiry SLA warnings and breaches, idle deals and housekeeping. Run it next
 * to the API; any number of workers can run because every queue is "stately" and every
 * sweep locks the rows it works on.
 *
 *   pnpm --filter @adas/api dev:worker
 */
import { buildWorker } from './jobs.js';
import { loadDotEnv, validateEnv } from './platform/config/index.js';
import { DatabaseService } from './platform/db/index.js';
import { createLogger } from './platform/logger/index.js';

loadDotEnv();
const env = validateEnv();
const logger = createLogger(env.LOG_LEVEL);

if (env.NODE_ENV === 'production') {
  // Same guard as the API (docs/PROGRESS.md, "Not production-ready"); removed in R8.
  logger.fatal('Refusing to start the worker with NODE_ENV=production: not production-ready yet.');
  process.exit(1);
}

const db = DatabaseService.connect(env.DATABASE_URL);
const { runner } = buildWorker(db, logger);
try {
  await db.ensureInitialized();
  await runner.start();
} catch (err) {
  // Start-up only: no record data can be in this error.
  const e = err as { name?: string; code?: string; message?: string };
  logger.fatal(
    { err: { name: e.name, code: e.code, message: e.message } },
    'worker could not start',
  );
  await db.close().catch(() => undefined);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  await runner.stop().catch((err: Error) => logger.error({ err: err.message }, 'stop failed'));
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
