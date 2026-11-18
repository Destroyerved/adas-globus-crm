import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import PgBoss from 'pg-boss';
import { type Logger } from 'pino';
import { type DatabaseService } from '../db/index.js';

/**
 * Background jobs on pg-boss (PRD 6.2, 6.9, 10.6), in the same PostgreSQL database as the app.
 * pg-boss talks through the app's own DatabaseService, so tests (PGlite) and production
 * (PostgreSQL) run the same code path. Each job is a periodic sweep whose work is idempotent:
 * state lives in the rows it touches (for example `reminder_sent_at`) and notifications carry
 * a unique dedupe key, so a retried or doubled run changes nothing.
 *
 * `JobRunner` also maintains a `worker_heartbeats` row (`0022_worker_heartbeats_and_backups`),
 * emitting heartbeats every `heartbeatIntervalSeconds` (default 15s) and after every job run,
 * tracking `active_jobs`, and draining in-flight work before marking `status = 'stopped'`.
 */

export interface PeriodicJob {
  /** Queue name, as in the PRD 6.9 job catalogue. */
  name: string;
  /** Cron in UTC (minute resolution), or an interval in seconds for faster loops. */
  cron?: string;
  everySeconds?: number;
  run: () => Promise<Record<string, number>>;
}

export interface JobRunnerOptions {
  install?: boolean;
  workerId?: string;
  heartbeatIntervalSeconds?: number;
  drainTimeoutMs?: number;
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
  readonly workerId: string;
  private readonly boss: PgBoss;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly hostname: string;
  private readonly pid: number;
  private readonly heartbeatIntervalSeconds: number;
  private readonly drainTimeoutMs: number;
  private started = false;
  private stopping = false;
  private activeJobs = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly jobs: PeriodicJob[],
    options: JobRunnerOptions = {},
  ) {
    this.workerId = options.workerId ?? `wrk_${randomUUID()}`;
    this.hostname = osHostname();
    this.pid = process.pid;
    this.heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? 15;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
    this.boss = new PgBoss({
      db: jobsDb(db),
      // Only tests install the schema here; production installs it in `pnpm db:migrate`.
      migrate: options.install ?? false,
    });
    this.boss.on('error', (err: Error) =>
      this.logger.error({ err: { name: err.name, message: err.message } }, 'job queue error'),
    );
  }

  getActiveJobsCount(): number {
    return this.activeJobs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    await this.upsertHeartbeat('running');
    await this.boss.start();
    for (const job of this.jobs) {
      if (!(await this.boss.getQueue(job.name))) {
        // "stately": at most one queued and one running job per queue, so sweeps never pile up.
        await this.boss.createQueue(job.name, { name: job.name, policy: 'stately' });
      }
      await this.boss.work(job.name, { pollingIntervalSeconds: 1 }, async () => {
        if (this.stopping) return;
        const started = Date.now();
        this.activeJobs += 1;
        await this.touchActiveJobs().catch(() => undefined);
        try {
          const result = await job.run();
          if (Object.values(result).some((n) => n > 0)) {
            this.logger.info({ job: job.name, ms: Date.now() - started, ...result }, 'job ran');
          }
        } finally {
          this.activeJobs = Math.max(0, this.activeJobs - 1);
          await this.recordJobCompleted(job.name).catch(() => undefined);
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

    if (this.heartbeatIntervalSeconds > 0) {
      const hbTimer = setInterval(
        () => void this.upsertHeartbeat('running').catch(() => undefined),
        this.heartbeatIntervalSeconds * 1000,
      );
      hbTimer.unref();
      this.timers.push(hbTimer);
    }

    this.started = true;
    this.logger.info(
      { workerId: this.workerId, jobs: this.jobs.map((j) => j.name) },
      'worker started',
    );
  }

  /** Emits an immediate heartbeat pulse (useful for tests and explicit liveness checks). */
  async pulseHeartbeat(): Promise<void> {
    await this.upsertHeartbeat(this.stopping ? 'draining' : 'running');
  }

  /** Queues one run now; ignored if a run is already queued or worker is draining. */
  async trigger(name: string): Promise<string | null> {
    if (this.stopping) return null;
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
    this.stopping = true;
    this.started = false;
    await this.upsertHeartbeat('draining').catch(() => undefined);

    await this.boss.stop({
      graceful: true,
      wait: true,
      timeout: this.drainTimeoutMs,
      close: false,
    });

    const drainDeadline = Date.now() + this.drainTimeoutMs;
    while (this.activeJobs > 0 && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    await this.markStopped().catch(() => undefined);
  }

  private async upsertHeartbeat(status: 'running' | 'draining'): Promise<void> {
    await this.db.query(
      `INSERT INTO worker_heartbeats (
         worker_id, hostname, pid, status, active_jobs, started_at, last_heartbeat_at, stopped_at
       ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NULL)
       ON CONFLICT (worker_id) DO UPDATE
       SET status = EXCLUDED.status,
           active_jobs = EXCLUDED.active_jobs,
           last_heartbeat_at = NOW(),
           stopped_at = NULL`,
      [this.workerId, this.hostname, this.pid, status, this.activeJobs],
    );
  }

  private async touchActiveJobs(): Promise<void> {
    await this.db.query(
      `UPDATE worker_heartbeats
       SET active_jobs = $2,
           last_heartbeat_at = NOW()
       WHERE worker_id = $1`,
      [this.workerId, this.activeJobs],
    );
  }

  private async recordJobCompleted(jobName: string): Promise<void> {
    await this.db.query(
      `UPDATE worker_heartbeats
       SET active_jobs = $2,
           last_heartbeat_at = NOW(),
           last_job_name = $3,
           last_job_at = NOW(),
           last_outbox_dispatch_at = CASE
             WHEN $3 = 'outbox.dispatch' THEN NOW()
             ELSE last_outbox_dispatch_at
           END
       WHERE worker_id = $1`,
      [this.workerId, this.activeJobs, jobName],
    );
  }

  private async markStopped(): Promise<void> {
    await this.db.query(
      `UPDATE worker_heartbeats
       SET status = 'stopped',
           active_jobs = 0,
           last_heartbeat_at = NOW(),
           stopped_at = NOW()
       WHERE worker_id = $1`,
      [this.workerId],
    );
  }
}
