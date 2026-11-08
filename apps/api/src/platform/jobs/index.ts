import PgBoss from 'pg-boss';
import { type Logger } from 'pino';
import { type DatabaseService } from '../db/index.js';

/**
 * Background jobs on pg-boss (PRD 6.2, 6.9), in the same PostgreSQL database as the app.
 * pg-boss talks through the app's own DatabaseService, so tests (PGlite) and production
 * (PostgreSQL) run the same code path. Each job is a periodic sweep whose work is idempotent:
 * state lives in the rows it touches (for example `reminder_sent_at`) and notifications carry
 * a unique dedupe key, so a retried or doubled run changes nothing.
 */

export interface PeriodicJob {
  /** Queue name, as in the PRD 6.9 job catalogue. */
  name: string;
  /** Cron in UTC (minute resolution), or an interval in seconds for faster loops. */
  cron?: string;
  everySeconds?: number;
  run: () => Promise<Record<string, number>>;
}

/** True for a parameterless script of several statements, such as pg-boss's schema setup. */
function isScript(sql: string): boolean {
  return sql.trim().replace(/;\s*$/, '').includes(';');
}

/** pg-boss's database adapter over the app's connection (pool in production, PGlite in tests). */
export function jobsDb(db: DatabaseService): { executeSql: PgBoss.Db['executeSql'] } {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      if (values.length === 0 && isScript(text)) {
        await db.exec(text);
        return { rows: [] };
      }
      const res = await db.query(text, values);
      return { rows: res.rows };
    },
  };
}

/**
 * Creates the pg-boss schema and the given queues. Production runs this from
 * `pnpm db:migrate` as the admin role; the worker itself never changes the schema.
 */
export async function installJobs(
  options: { connectionString: string } | { db: DatabaseService },
  queues: string[],
): Promise<void> {
  const boss = new PgBoss({
    ...('db' in options ? { db: jobsDb(options.db) } : options),
    migrate: true,
    schedule: false,
    supervise: false,
  });
  await boss.start();
  for (const name of queues) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { name, policy: 'stately' });
  }
  await boss.stop({ graceful: false, wait: true, close: !('db' in options) });
}

export class JobRunner {
  private readonly boss: PgBoss;
  private readonly timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(
    db: DatabaseService,
    private readonly logger: Logger,
    private readonly jobs: PeriodicJob[],
    options: { install?: boolean } = {},
  ) {
    this.boss = new PgBoss({
      db: jobsDb(db),
      // Only tests install the schema here; production installs it in `pnpm db:migrate`.
      migrate: options.install ?? false,
    });
    this.boss.on('error', (err: Error) =>
      this.logger.error({ err: { name: err.name, message: err.message } }, 'job queue error'),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const job of this.jobs) {
      if (!(await this.boss.getQueue(job.name))) {
        // "stately": at most one queued and one running job per queue, so sweeps never pile up.
        await this.boss.createQueue(job.name, { name: job.name, policy: 'stately' });
      }
      await this.boss.work(job.name, { pollingIntervalSeconds: 1 }, async () => {
        const started = Date.now();
        const result = await job.run();
        if (Object.values(result).some((n) => n > 0)) {
          this.logger.info({ job: job.name, ms: Date.now() - started, ...result }, 'job ran');
        }
      });
      if (job.cron) {
        await this.boss.schedule(job.name, job.cron, {}, { tz: 'UTC' });
      } else if (job.everySeconds) {
        const timer = setInterval(() => void this.trigger(job.name), job.everySeconds * 1000);
        timer.unref();
        this.timers.push(timer);
      }
    }
    this.started = true;
    this.logger.info({ jobs: this.jobs.map((j) => j.name) }, 'worker started');
  }

  /** Queues one run now; ignored if a run is already queued. */
  async trigger(name: string): Promise<string | null> {
    try {
      return await this.boss.send(name, {});
    } catch (err) {
      this.logger.error({ job: name, err: (err as Error).message }, 'could not queue job');
      return null;
    }
  }

  /** Waits until the queue has nothing queued or running (tests and graceful shutdown). */
  async idle(name: string, timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const waiting = await this.boss.getQueueSize(name, { before: 'completed' });
      if (waiting === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Job ${name} did not finish within ${timeoutMs} ms`);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: true, wait: true, timeout: 15_000, close: false });
  }
}
