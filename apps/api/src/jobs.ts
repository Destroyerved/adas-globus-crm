import { type Logger } from 'pino';
import { type DatabaseService } from './platform/db/index.js';
import { type FileStorage } from './platform/files/index.js';
import { JobRunner, type PeriodicJob } from './platform/jobs/index.js';
import { OutboxDispatcher } from './platform/outbox/index.js';
import { AuthAndUsersService } from './modules/auth/index.js';
import { BulkActionService, CrmJobs, CrmListService } from './modules/crm/index.js';
import { DuplicateService } from './modules/duplicates/index.js';
import { ExportService } from './modules/exports/index.js';
import { ImportProcessor } from './modules/imports/index.js';

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
] as const;

/**
 * Deletes what nobody needs any more: replayable responses after their 24 hours
 * (ADR 0004), sessions that ended more than 30 days ago, public per-IP rate events older than
 * 1 hour, and raw website inquiry rows older than 24 months (PRD 4.18, Q10 default).
 */
export async function purgeExpired(db: DatabaseService): Promise<{
  idempotencyKeys: number;
  sessions: number;
  rateEvents: number;
  inquiries: number;
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
  return {
    idempotencyKeys: keys.rowCount,
    sessions: sessions.rowCount,
    rateEvents: rateEvents.rowCount,
    inquiries: inquiries.rowCount,
  };
}

export function buildWorker(
  db: DatabaseService,
  logger: Logger,
  options: { install?: boolean; files: FileStorage },
): {
  runner: JobRunner;
  outbox: OutboxDispatcher;
  crm: CrmJobs;
  imports: ImportProcessor;
  duplicates: DuplicateService;
  exports: ExportService;
  bulk: BulkActionService;
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
  // Handlers for outbound webhooks (n8n) and sequences attach here as those phases land.
  const outbox = new OutboxDispatcher(db, logger);
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
  ];
  return {
    runner: new JobRunner(db, logger, jobs, { install: options.install }),
    outbox,
    crm,
    imports,
    duplicates,
    exports: exportService,
    bulk,
    jobs,
  };
}
