/**
 * The background worker (PRD 6.9): pg-boss queues for outbox dispatch, task reminders and
 * overdue alerts, inquiry SLA warnings and breaches, idle deals, imports and housekeeping. Run it next
 * to the API; any number of workers can run because every queue is "stately" and every
 * sweep locks the rows it works on.
 *
 *   pnpm --filter @adas/api dev:worker
 */
import { buildWorker } from './jobs.js';
import { ComplianceService } from './modules/compliance/index.js';
import { InboxService } from './modules/inbox/index.js';
import { IntelligenceService } from './modules/intelligence/index.js';
import { OutreachService } from './modules/outreach/index.js';
import { ApolloClient } from './platform/apollo/index.js';
import {
  loadDotEnv,
  resolveConfigPath,
  validateEnv,
  verifyProductionReadiness,
} from './platform/config/index.js';
import { loadSecretBox } from './platform/crypto/index.js';
import { DatabaseService } from './platform/db/index.js';
import { LocalFileStorage } from './platform/files/index.js';
import { createLogger } from './platform/logger/index.js';
import {
  EspBulkSender,
  GoogleGmailMailboxClient,
  MailpitTransport,
  MicrosoftGraphMailboxClient,
} from './platform/mail-transport/index.js';

loadDotEnv();
const env = validateEnv();
const logger = createLogger(env.LOG_LEVEL);

const db = DatabaseService.connect(env.DATABASE_URL);
const secretBox = loadSecretBox(
  resolveConfigPath(env.TOKEN_ENCRYPTION_KEY_FILE),
  env.TOKEN_ENCRYPTION_KEY_VERSION,
  env.NODE_ENV === 'production',
);
const mailpit = new MailpitTransport(env.MAIL_LIVE, env.NODE_ENV, env.MAILPIT_HTTP_URL);
const espSender = new EspBulkSender({
  provider: env.ESP_PROVIDER,
  apiBaseUrl: env.ESP_API_BASE_URL,
  apiKeyFile: resolveConfigPath(env.ESP_API_KEY_FILE),
  webhookSecretFile: resolveConfigPath(env.ESP_WEBHOOK_SECRET_FILE),
  sendingDomain: env.ESP_SENDING_DOMAIN,
  nodeEnv: env.NODE_ENV,
  mailLive: env.MAIL_LIVE,
});
const graph = new MicrosoftGraphMailboxClient({
  tenantId: env.ENTRA_TENANT_ID,
  clientId: env.ENTRA_CLIENT_ID,
  clientSecretFile: resolveConfigPath(env.ENTRA_CLIENT_SECRET_FILE),
  redirectUri: env.ENTRA_MAIL_REDIRECT_URI,
  authorityBaseUrl: env.MICROSOFT_AUTHORITY_BASE_URL,
  graphBaseUrl: env.MICROSOFT_GRAPH_BASE_URL,
});
const gmail = new GoogleGmailMailboxClient({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecretFile: resolveConfigPath(env.GOOGLE_CLIENT_SECRET_FILE),
  redirectUri: env.GOOGLE_MAIL_REDIRECT_URI,
  authUrl: env.GOOGLE_AUTH_URL,
  tokenUrl: env.GOOGLE_TOKEN_URL,
  gmailBaseUrl: env.GOOGLE_GMAIL_BASE_URL,
  pubsubTopic: env.GOOGLE_PUBSUB_TOPIC,
});
const inbox = new InboxService(db, graph, mailpit, {
  nodeEnv: env.NODE_ENV,
  mailLive: env.MAIL_LIVE,
  publicHost: env.APP_PUBLIC_HOST,
  maxAttachmentBytes: env.MAX_ATTACHMENT_UPLOAD_BYTES,
  secretBox,
  gmail,
});
const outreach = new OutreachService(db, new ComplianceService(db), mailpit, {
  nodeEnv: env.NODE_ENV,
  mailLive: env.MAIL_LIVE,
  publicHost: env.APP_PUBLIC_HOST,
  sendingSubdomain: env.ESP_SENDING_DOMAIN,
  espSender,
  liveMailboxSender: (senderUserId, payload) =>
    inbox.sendSequenceMessageViaUserMailbox(senderUserId, payload),
});
const intelligence = new IntelligenceService(db, {
  apolloClient: new ApolloClient({
    apiBaseUrl: env.APOLLO_API_BASE_URL,
    apiKeyFile: resolveConfigPath(env.APOLLO_API_KEY_FILE),
  }),
  secretBox,
  bookingsWebhookSecretFile: resolveConfigPath(env.BOOKINGS_WEBHOOK_SECRET_FILE),
  nodeEnv: env.NODE_ENV,
  mailLive: env.MAIL_LIVE,
  publicHost: env.APP_PUBLIC_HOST,
  allowPrivateWebhookTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS || env.NODE_ENV !== 'production',
});
const { runner } = buildWorker(db, logger, {
  files: new LocalFileStorage(resolveConfigPath(env.FILE_STORAGE_LOCAL_PATH)),
  secretBox,
  inbox,
  outreach,
  intelligence,
});
try {
  await db.ensureInitialized();
  await verifyProductionReadiness({
    env,
    db,
    secretBox,
    resolvePath: resolveConfigPath,
  });
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
