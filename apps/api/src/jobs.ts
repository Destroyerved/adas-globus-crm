import { type Logger } from 'pino';
import { type DatabaseService } from './platform/db/index.js';
import { JobRunner, type PeriodicJob } from './platform/jobs/index.js';
import { OutboxDispatcher } from './platform/outbox/index.js';
import { CrmJobs } from './modules/crm/index.js';

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
] as const;

/**
 * Deletes what nobody needs any more: replayable responses after their 24 hours
 * (ADR 0004) and sessions that ended more than 30 days ago.
 */
export async function purgeExpired(
  db: DatabaseService,
): Promise<{ idempotencyKeys: number; sessions: number }> {
  const keys = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );
  const sessions = await db.query(
    `DELETE FROM sessions
     WHERE expires_at < NOW() - INTERVAL '30 days' OR revoked_at < NOW() - INTERVAL '30 days'`,
  );
  return { idempotencyKeys: keys.rowCount, sessions: sessions.rowCount };
}

export function buildWorker(
  db: DatabaseService,
  logger: Logger,
  options: { install?: boolean } = {},
): { runner: JobRunner; outbox: OutboxDispatcher; crm: CrmJobs; jobs: PeriodicJob[] } {
  const crm = new CrmJobs(db);
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
    { name: 'housekeeping.purge', cron: '23 * * * *', run: () => purgeExpired(db) },
  ];
  return { runner: new JobRunner(db, logger, jobs, options), outbox, crm, jobs };
}
