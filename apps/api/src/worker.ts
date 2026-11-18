/**
 * The background worker (PRD 6.9): pg-boss queues for outbox dispatch, task reminders and
 * overdue alerts, inquiry SLA warnings and breaches, idle deals, imports and housekeeping. Run it next
 * to the API; any number of workers can run because every queue is "stately" and every
 * sweep locks the rows it works on.
 *
 *   pnpm --filter @adas/api dev:worker
 */
import { buildWorker } from './jobs.js';
import { InboxService } from './modules/inbox/index.js';
import { loadDotEnv, resolveConfigPath, validateEnv } from './platform/config/index.js';
import { loadSecretBox } from './platform/crypto/index.js';
import { DatabaseService } from './platform/db/index.js';
import { LocalFileStorage } from './platform/files/index.js';
import { createLogger } from './platform/logger/index.js';
import { MailpitTransport, MicrosoftGraphMailboxClient } from './platform/mail-transport/index.js';

loadDotEnv();
const env = validateEnv();
const logger = createLogger(env.LOG_LEVEL);

if (env.NODE_ENV === 'production') {
  // Same guard as the API (docs/PROGRESS.md, "Not production-ready"); removed in R8.
  logger.fatal('Refusing to start the worker with NODE_ENV=production: not production-ready yet.');
  process.exit(1);
}

const db = DatabaseService.connect(env.DATABASE_URL);
const secretBox = loadSecretBox(
  resolveConfigPath(env.TOKEN_ENCRYPTION_KEY_FILE),
  env.TOKEN_ENCRYPTION_KEY_VERSION,
  false,
);
const graph = new MicrosoftGraphMailboxClient({
  tenantId: env.ENTRA_TENANT_ID,
  clientId: env.ENTRA_CLIENT_ID,
  clientSecretFile: resolveConfigPath(env.ENTRA_CLIENT_SECRET_FILE),
  redirectUri: env.ENTRA_MAIL_REDIRECT_URI,
  authorityBaseUrl: env.MICROSOFT_AUTHORITY_BASE_URL,
  graphBaseUrl: env.MICROSOFT_GRAPH_BASE_URL,
});
const inbox = new InboxService(
  db,
  graph,
  new MailpitTransport(env.MAIL_LIVE, env.NODE_ENV, env.MAILPIT_HTTP_URL),
  {
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
    publicHost: env.APP_PUBLIC_HOST,
    maxAttachmentBytes: env.MAX_ATTACHMENT_UPLOAD_BYTES,
    secretBox,
  },
);
const { runner } = buildWorker(db, logger, {
  files: new LocalFileStorage(resolveConfigPath(env.FILE_STORAGE_LOCAL_PATH)),
  inbox,
});
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
