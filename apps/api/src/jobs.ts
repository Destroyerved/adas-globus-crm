import { type Logger } from 'pino';
import { type SecretBox } from './platform/crypto/index.js';
import { type DatabaseService } from './platform/db/index.js';
import { type FileStorage } from './platform/files/index.js';
import { JobRunner, type PeriodicJob } from './platform/jobs/index.js';
import { MailpitTransport, MicrosoftGraphMailboxClient } from './platform/mail-transport/index.js';
import { OutboxDispatcher } from './platform/outbox/index.js';
import { AuthAndUsersService } from './modules/auth/index.js';
import { ComplianceService } from './modules/compliance/index.js';
import { BulkActionService, CrmJobs, CrmListService } from './modules/crm/index.js';
import { DuplicateService } from './modules/duplicates/index.js';
import { ExportService } from './modules/exports/index.js';
import { ImportProcessor } from './modules/imports/index.js';
import { InboxService } from './modules/inbox/index.js';
import { IntelligenceService } from './modules/intelligence/index.js';
import { OutreachService } from './modules/outreach/index.js';

/**
 * The worker's jobs (PRD 6.9 job catalogue). Composition lives here, outside `platform/`, so
 * platform code never imports business modules.
 */

/** Every queue the worker uses; `pnpm db:migrate` creates them as the admin role. */
export const JOB_QUEUES = [
  'outbox.dispatch',
  'tasks.reminders',
  'sla.check',
  'deals.idle',
  'housekeeping.purge',
  'import.process',
  'duplicates.scan',
  'export.build',
  'bulk.execute',
  'mail.sync',
  'mail.subscriptions.renew',
  'sequence.tick',
  'campaign.tick',
  'webhook.deliver',
] as const;

/**
 * Deletes what nobody needs any more: replayable responses after their 24 hours
 * (ADR 0004), sessions that ended more than 30 days ago, public per-IP rate events older than
 * 1 hour, raw website inquiry rows older than 24 months, email message bodies 24 months
 * after the last activity on the contact, and terminal webhook delivery logs older than 30 days
 * (PRD 4.18, Q10 default).
 */
export async function purgeExpired(db: DatabaseService): Promise<{
  idempotencyKeys: number;
  sessions: number;
  rateEvents: number;
  inquiries: number;
  emailBodiesPurged: number;
  webhookDeliveriesPurged: number;
}> {
  const keys = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );
  const sessions = await db.query(
    `DELETE FROM sessions
     WHERE expires_at < NOW() - INTERVAL '30 days' OR revoked_at < NOW() - INTERVAL '30 days'`,
  );
  const rateEvents = await db.query(
    `DELETE FROM public_rate_events WHERE created_at < NOW() - INTERVAL '1 hour'`,
  );
  const inquiries = await db.query(
    `DELETE FROM inquiries WHERE created_at < NOW() - INTERVAL '24 months'`,
  );
  const emailBodies = await db.query(
    `UPDATE email_messages m
     SET body_text = '[Purged per 24-month retention policy]',
         body_html_sanitized = NULL,
         body_preview = '[Purged per 24-month retention policy]'
     WHERE m.sent_at < NOW() - INTERVAL '24 months'
       AND m.body_text != '[Purged per 24-month retention policy]'
       AND m.body_text != '[Erased per privacy request]'
       AND NOT EXISTS (
         SELECT 1 FROM email_threads t
         JOIN contacts c ON c.id = t.contact_id
         WHERE t.id = m.thread_id
           AND COALESCE(c.last_contacted_at, c.updated_at) >= NOW() - INTERVAL '24 months'
       )`,
  );
  const webhookDeliveries = await db.query(
    `DELETE FROM webhook_deliveries
     WHERE status IN ('delivered', 'failed') AND created_at < NOW() - INTERVAL '30 days'`,
  );
  return {
    idempotencyKeys: keys.rowCount,
    sessions: sessions.rowCount,
    rateEvents: rateEvents.rowCount,
    inquiries: inquiries.rowCount,
    emailBodiesPurged: emailBodies.rowCount,
    webhookDeliveriesPurged: webhookDeliveries.rowCount,
  };
}

export function buildWorker(
  db: DatabaseService,
  logger: Logger,
  options: {
    install?: boolean;
    files: FileStorage;
    secretBox?: SecretBox | null;
    inbox?: InboxService;
    outreach?: OutreachService;
    intelligence?: IntelligenceService;
  },
): {
  runner: JobRunner;
  outbox: OutboxDispatcher;
  crm: CrmJobs;
  imports: ImportProcessor;
  duplicates: DuplicateService;
  exports: ExportService;
  bulk: BulkActionService;
  inbox: InboxService;
  outreach: OutreachService;
  intelligence: IntelligenceService;
  jobs: PeriodicJob[];
} {
  const crm = new CrmJobs(db);
  const auth = new AuthAndUsersService(db);
  const bulk = new BulkActionService(db, (userId) => auth.resolveSessionUser(userId), logger);
  // Rows are worked as the person who started the import, with their current access.
  const imports = new ImportProcessor(
    db,
    options.files,
    (userId) => auth.resolveSessionUser(userId),
    logger,
  );
  const duplicates = new DuplicateService(db);
  // Large exports are built as the person who asked, with their current access.
  const exportService = new ExportService(
    db,
    options.files,
    new CrmListService(db),
    (userId) => auth.resolveSessionUser(userId),
    logger,
  );
  const defaultTransport = new MailpitTransport(false, 'test');
  const inbox =
    options.inbox ??
    new InboxService(
      db,
      new MicrosoftGraphMailboxClient({
        tenantId: '00000000-0000-0000-0000-000000000000',
        clientId: '00000000-0000-0000-0000-000000000000',
        clientSecretFile: './secrets/entra_client_secret.txt',
        redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      }),
      defaultTransport,
      {
        nodeEnv: 'test',
        mailLive: false,
        publicHost: 'go.adasglobuspro.com',
        maxAttachmentBytes: 20_971_520,
        secretBox: options.secretBox ?? null,
      },
    );
  const outreach =
    options.outreach ??
    new OutreachService(db, new ComplianceService(db), defaultTransport, {
      nodeEnv: 'test',
      mailLive: false,
      publicHost: 'go.adasglobuspro.com',
    });
  const intelligence =
    options.intelligence ??
    new IntelligenceService(db, {
      secretBox: options.secretBox ?? null,
      nodeEnv: 'test',
      allowPrivateWebhookTargets: true,
    });

  // Outbox handlers for sequence stop conditions and outbound webhooks (PRD 4.12, 4.14, 6.9).
  const outbox = new OutboxDispatcher(db, logger);
  outbox.on('deal.created', (event, tx) => outreach.handleOutboxStopCondition(event, tx));
  outbox.on('deal.won', (event, tx) => outreach.handleOutboxStopCondition(event, tx));
  outbox.on('activity.logged', (event, tx) => outreach.handleOutboxStopCondition(event, tx));
  outbox.on('*', (event, tx) => intelligence.enqueueMatchingWebhooks(event, tx));

  const jobs: PeriodicJob[] = [
    { name: 'outbox.dispatch', everySeconds: 2, run: () => outbox.dispatch() },
    {
      name: 'tasks.reminders',
      cron: '* * * * *',
      run: async () => ({
        ...(await crm.sendTaskReminders()),
        ...(await crm.notifyOverdueTasks()),
      }),
    },
    { name: 'sla.check', cron: '*/5 * * * *', run: () => crm.checkInquirySla() },
    { name: 'deals.idle', cron: '7 * * * *', run: () => crm.flagIdleDeals() },
    {
      name: 'housekeeping.purge',
      cron: '23 * * * *',
      run: async () => ({
        ...(await purgeExpired(db)),
        exportFiles: await exportService.purgeExpired(),
      }),
    },
    { name: 'import.process', everySeconds: 2, run: () => imports.processNext() },
    // Probable duplicates among records added or changed by hand, the website or the API.
    {
      name: 'duplicates.scan',
      cron: '* * * * *',
      run: () => duplicates.scan({ budgetMs: 20_000 }),
    },
    { name: 'export.build', everySeconds: 2, run: () => exportService.processNext() },
    {
      name: 'bulk.execute',
      everySeconds: 2,
      run: async () => {
        const res = await bulk.processNext();
        return { worked: res.jobId ? 1 : 0 };
      },
    },
    {
      name: 'mail.sync',
      everySeconds: 15,
      run: () => inbox.syncDueMailboxes(),
    },
    {
      name: 'mail.subscriptions.renew',
      cron: '12 * * * *',
      run: () => inbox.renewExpiringSubscriptions(),
    },
    {
      name: 'sequence.tick',
      cron: '* * * * *',
      run: () => outreach.runSequenceTick(),
    },
    {
      name: 'campaign.tick',
      cron: '* * * * *',
      run: () => outreach.runCampaignTick(),
    },
    {
      name: 'webhook.deliver',
      everySeconds: 3,
      run: () => intelligence.deliverDueWebhooks(),
    },
  ];
  return {
    runner: new JobRunner(db, logger, jobs, { install: options.install }),
    outbox,
    crm,
    imports,
    duplicates,
    exports: exportService,
    bulk,
    inbox,
    outreach,
    intelligence,
    jobs,
  };
}
