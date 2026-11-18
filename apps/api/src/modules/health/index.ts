import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  BackupRunView,
  DeadLetterEventView,
  HealthCheckResponse,
  SessionUser,
  SystemHealthOverview,
  WorkerHeartbeatView,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { NotFoundDomainError } from '../../platform/errors/index.js';
import { requireCapability } from '../../platform/scope/index.js';

export { registerHealthRoutes } from './routes.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  service: 'adas-crm-api';
}

export interface HealthServiceOptions {
  nodeEnv: string;
  mailLive: boolean;
  devLoginEnabled: boolean;
}

function isoString(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? String(val) : parsed.toISOString();
}

export class HealthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly options: HealthServiceOptions,
  ) {}

  /**
   * Deep readiness & operational telemetry probe for `/healthz` and `/api/v1/healthz` (PRD 10.6).
   * - Never exposes hostnames, PIDs, paths, or PII because `/healthz` is exposed on `go.`.
   * - Returns HTTP `503` whenever PostgreSQL is unreachable, or when `?strict=1` is requested
   *   and `status !== 'ok'` (e.g. Uptime Kuma strict outbox/worker/backup alert).
   */
  async checkReadiness(params: { strict?: boolean } = {}): Promise<{
    httpStatus: 200 | 503;
    body: HealthCheckResponse;
  }> {
    const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));
    const dbStart = performance.now();

    try {
      await this.db.ensureInitialized();
      const probe = await this.db.query<{
        pending_count: number;
        oldest_pending_seconds: number | null;
        dead_letter_count: number;
        active_workers: number;
        stale_running_workers: number;
        last_heartbeat_seconds: number | null;
        last_outbox_dispatch_seconds: number | null;
        last_backup_hours: number | null;
        last_drill_days: number | null;
        expiring_subs: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM outbox_events WHERE status = 'pending') AS pending_count,
           (SELECT CASE WHEN MIN(created_at) IS NULL THEN NULL
                        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))))::int END
              FROM outbox_events WHERE status = 'pending') AS oldest_pending_seconds,
           (SELECT COUNT(*)::int FROM outbox_events WHERE status = 'dead_letter') AS dead_letter_count,
           (SELECT COUNT(*)::int FROM worker_heartbeats
              WHERE status = 'running' AND last_heartbeat_at >= NOW() - INTERVAL '60 seconds') AS active_workers,
           (SELECT COUNT(*)::int FROM worker_heartbeats
              WHERE status = 'running' AND last_heartbeat_at < NOW() - INTERVAL '60 seconds') AS stale_running_workers,
           (SELECT CASE WHEN MAX(last_heartbeat_at) IS NULL THEN NULL
                        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(last_heartbeat_at)))))::int END
              FROM worker_heartbeats) AS last_heartbeat_seconds,
           (SELECT CASE WHEN MAX(last_outbox_dispatch_at) IS NULL THEN NULL
                        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(last_outbox_dispatch_at)))))::int END
              FROM worker_heartbeats) AS last_outbox_dispatch_seconds,
           (SELECT CASE WHEN MAX(completed_at) IS NULL THEN NULL
                        ELSE ROUND((GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MAX(completed_at)))) / 3600.0)::numeric, 2)::float8 END
              FROM backup_runs
              WHERE kind IN ('pg_dump', 'wal_base') AND status = 'succeeded') AS last_backup_hours,
           (SELECT CASE WHEN MAX(completed_at) IS NULL THEN NULL
                        ELSE ROUND((GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MAX(completed_at)))) / 86400.0)::numeric, 2)::float8 END
              FROM backup_runs
              WHERE kind = 'restore_drill' AND status = 'succeeded') AS last_drill_days,
           (SELECT COUNT(*)::int FROM mailbox_connections
              WHERE status = 'connected'
                AND (
                  (inbox_subscription_id IS NOT NULL
                    AND inbox_subscription_expires_at IS NOT NULL
                    AND inbox_subscription_expires_at <= NOW() + INTERVAL '2 hours')
                  OR
                  (sent_subscription_id IS NOT NULL
                    AND sent_subscription_expires_at IS NOT NULL
                    AND sent_subscription_expires_at <= NOW() + INTERVAL '2 hours')
                )) AS expiring_subs`,
      );
      const latencyMs = Math.round((performance.now() - dbStart) * 100) / 100;
      const row = probe.rows[0];

      const pendingCount = row?.pending_count ?? 0;
      const oldestPendingSeconds = row?.oldest_pending_seconds ?? null;
      const deadLetterCount = row?.dead_letter_count ?? 0;
      const activeWorkers = row?.active_workers ?? 0;
      const staleRunningWorkers = row?.stale_running_workers ?? 0;
      const lastHeartbeatSecondsAgo = row?.last_heartbeat_seconds ?? null;
      const lastOutboxDispatchSecondsAgo = row?.last_outbox_dispatch_seconds ?? null;
      const lastBackupHoursAgo = row?.last_backup_hours ?? null;
      const lastRestoreDrillDaysAgo = row?.last_drill_days ?? null;
      const expiringSubscriptions = row?.expiring_subs ?? 0;

      // PRD 10.6 thresholds: oldest pending outbox < 5 min (300s), worker heartbeat < 60s, last backup < 26h.
      const outboxOk =
        deadLetterCount === 0 && (oldestPendingSeconds === null || oldestPendingSeconds < 300);
      const workerState: 'active' | 'idle' | 'stale' =
        activeWorkers > 0 ? 'active' : staleRunningWorkers > 0 ? 'stale' : 'idle';
      const backupsState: 'ok' | 'stale' | 'unrecorded' =
        lastBackupHoursAgo === null ? 'unrecorded' : lastBackupHoursAgo <= 26 ? 'ok' : 'stale';

      const degraded =
        !outboxOk ||
        workerState === 'stale' ||
        backupsState === 'stale' ||
        (Boolean(params.strict) &&
          this.options.nodeEnv === 'production' &&
          workerState !== 'active');

      const status: 'ok' | 'degraded' = degraded ? 'degraded' : 'ok';
      const httpStatus: 200 | 503 = params.strict && status !== 'ok' ? 503 : 200;

      return {
        httpStatus,
        body: {
          status,
          service: 'adas-crm-api',
          mailLive: this.options.mailLive,
          devLoginEnabled: this.options.devLoginEnabled,
          uptimeSeconds,
          checks: {
            database: { ok: true, latencyMs },
            outbox: {
              ok: outboxOk,
              pendingCount,
              oldestPendingSeconds,
              deadLetterCount,
            },
            worker: {
              state: workerState,
              activeWorkers,
              lastHeartbeatSecondsAgo,
              lastOutboxDispatchSecondsAgo,
            },
            backups: {
              state: backupsState,
              lastBackupHoursAgo,
              lastRestoreDrillDaysAgo,
            },
            mailSync: {
              expiringSubscriptions,
            },
          },
        },
      };
    } catch {
      return {
        httpStatus: 503,
        body: {
          status: 'down',
          service: 'adas-crm-api',
          mailLive: this.options.mailLive,
          devLoginEnabled: this.options.devLoginEnabled,
          uptimeSeconds,
          checks: {
            database: { ok: false, latencyMs: null },
            outbox: {
              ok: false,
              pendingCount: 0,
              oldestPendingSeconds: null,
              deadLetterCount: 0,
            },
            worker: {
              state: 'stale',
              activeWorkers: 0,
              lastHeartbeatSecondsAgo: null,
              lastOutboxDispatchSecondsAgo: null,
            },
            backups: {
              state: 'unrecorded',
              lastBackupHoursAgo: null,
              lastRestoreDrillDaysAgo: null,
            },
            mailSync: {
              expiringSubscriptions: 0,
            },
          },
        },
      };
    }
  }

  /**
   * Authenticated Admin System Health dashboard (`GET /api/v1/admin/system-health`).
   * Never returns raw event payloads so personal data cannot leak through operational screens.
   */
  async getSystemHealthOverview(user: SessionUser): Promise<SystemHealthOverview> {
    requireCapability(user, 'settings.manage');

    const readiness = await this.checkReadiness();
    const mem = process.memoryUsage();

    const [queueStatsRes, workersRes, dlqRes, backupsRes] = await Promise.all([
      this.db.query<{
        pgboss_installed: boolean;
        outbox_pending: number;
        outbox_processed_24h: number;
        outbox_dead_letter: number;
        oldest_pending_seconds: number | null;
        webhooks_pending: number;
        webhooks_retrying: number;
        webhooks_failed_24h: number;
      }>(
        `SELECT
           EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS pgboss_installed,
           (SELECT COUNT(*)::int FROM outbox_events WHERE status = 'pending') AS outbox_pending,
           (SELECT COUNT(*)::int FROM outbox_events
              WHERE status = 'processed' AND processed_at >= NOW() - INTERVAL '24 hours') AS outbox_processed_24h,
           (SELECT COUNT(*)::int FROM outbox_events WHERE status = 'dead_letter') AS outbox_dead_letter,
           (SELECT CASE WHEN MIN(created_at) IS NULL THEN NULL
                        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))))::int END
              FROM outbox_events WHERE status = 'pending') AS oldest_pending_seconds,
           (SELECT COUNT(*)::int FROM webhook_deliveries WHERE status = 'pending') AS webhooks_pending,
           (SELECT COUNT(*)::int FROM webhook_deliveries WHERE status = 'retrying') AS webhooks_retrying,
           (SELECT COUNT(*)::int FROM webhook_deliveries
              WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '24 hours') AS webhooks_failed_24h`,
      ),
      this.db.query<{
        worker_id: string;
        hostname: string;
        pid: number;
        status: 'running' | 'draining' | 'stopped';
        active_jobs: number;
        started_at: Date | string;
        last_heartbeat_at: Date | string;
        last_job_name: string | null;
        last_job_at: Date | string | null;
        last_outbox_dispatch_at: Date | string | null;
        stopped_at: Date | string | null;
      }>(
        `SELECT worker_id, hostname, pid, status, active_jobs,
                started_at, last_heartbeat_at, last_job_name, last_job_at,
                last_outbox_dispatch_at, stopped_at
         FROM worker_heartbeats
         ORDER BY last_heartbeat_at DESC
         LIMIT 20`,
      ),
      this.db.query<{
        id: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        attempts: number;
        retry_count: number;
        last_error: string | null;
        created_at: Date | string;
        available_at: Date | string;
      }>(
        `SELECT id, event_type, aggregate_type, aggregate_id,
                attempts, retry_count, last_error, created_at, available_at
         FROM outbox_events
         WHERE status = 'dead_letter'
         ORDER BY created_at DESC
         LIMIT 100`,
      ),
      this.db.query<{
        id: string;
        kind: 'pg_dump' | 'wal_base' | 'files_snapshot' | 'restore_drill' | 'pre_deploy';
        status: 'running' | 'succeeded' | 'failed';
        size_bytes: string | number | bigint | null;
        encrypted: boolean;
        offsite_synced: boolean;
        started_at: Date | string;
        completed_at: Date | string | null;
        duration_ms: number | null;
        error_code: string | null;
      }>(
        `SELECT id, kind, status, size_bytes::text AS size_bytes, encrypted, offsite_synced,
                started_at, completed_at, duration_ms, error_code
         FROM backup_runs
         ORDER BY started_at DESC
         LIMIT 25`,
      ),
    ]);

    const q = queueStatsRes.rows[0];
    const workers: WorkerHeartbeatView[] = workersRes.rows.map((w) => ({
      worker_id: w.worker_id,
      hostname: w.hostname,
      pid: w.pid,
      status: w.status,
      active_jobs: w.active_jobs,
      started_at: isoString(w.started_at) ?? new Date(0).toISOString(),
      last_heartbeat_at: isoString(w.last_heartbeat_at) ?? new Date(0).toISOString(),
      last_job_name: w.last_job_name,
      last_job_at: isoString(w.last_job_at),
      last_outbox_dispatch_at: isoString(w.last_outbox_dispatch_at),
      stopped_at: isoString(w.stopped_at),
    }));

    const deadLetters: DeadLetterEventView[] = dlqRes.rows.map((d) => ({
      id: d.id,
      event_type: d.event_type,
      aggregate_type: d.aggregate_type,
      aggregate_id: d.aggregate_id,
      attempts: d.attempts,
      retry_count: d.retry_count,
      last_error: d.last_error,
      created_at: isoString(d.created_at) ?? new Date(0).toISOString(),
      available_at: isoString(d.available_at) ?? new Date(0).toISOString(),
    }));

    const backups: BackupRunView[] = backupsRes.rows.map((b) => ({
      id: b.id,
      kind: b.kind,
      status: b.status,
      size_bytes: b.size_bytes === null || b.size_bytes === undefined ? null : String(b.size_bytes),
      encrypted: b.encrypted,
      offsite_synced: b.offsite_synced,
      started_at: isoString(b.started_at) ?? new Date(0).toISOString(),
      completed_at: isoString(b.completed_at),
      duration_ms: b.duration_ms,
      error_code: b.error_code,
    }));

    return {
      readiness: readiness.body,
      process: {
        nodeVersion: process.version,
        uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
      },
      queues: {
        pgBossInstalled: Boolean(q?.pgboss_installed),
        outboxPending: q?.outbox_pending ?? 0,
        outboxProcessed24h: q?.outbox_processed_24h ?? 0,
        outboxDeadLetter: q?.outbox_dead_letter ?? 0,
        oldestPendingSeconds: q?.oldest_pending_seconds ?? null,
        webhooksPending: q?.webhooks_pending ?? 0,
        webhooksRetrying: q?.webhooks_retrying ?? 0,
        webhooksFailed24h: q?.webhooks_failed_24h ?? 0,
      },
      workers,
      deadLetters,
      backups,
    };
  }

  async retryDeadLetterEvent(
    user: SessionUser,
    eventId: string,
    ip: string | null = null,
  ): Promise<{ id: string; status: 'pending'; retryCount: number }> {
    requireCapability(user, 'settings.manage');

    return this.db.transaction(async (tx) => {
      const res = await tx.query<{
        id: string;
        event_type: string;
        aggregate_type: string;
        retry_count: number;
      }>(
        `UPDATE outbox_events
         SET status = 'pending',
             attempts = 0,
             retry_count = retry_count + 1,
             available_at = NOW(),
             last_error = NULL
         WHERE id = $1 AND status = 'dead_letter'
         RETURNING id, event_type, aggregate_type, retry_count`,
        [eventId],
      );
      const updated = res.rows[0];
      if (!updated) {
        throw new NotFoundDomainError('Dead-letter outbox event', eventId);
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'outbox.dead_letter_retried',
        entityType: 'outbox_event',
        entityId: updated.id,
        metadata: {
          eventType: updated.event_type,
          aggregateType: updated.aggregate_type,
          retryCount: updated.retry_count,
        },
        ipAddress: ip,
      });

      return {
        id: updated.id,
        status: 'pending',
        retryCount: updated.retry_count,
      };
    });
  }

  async retryAllDeadLetters(
    user: SessionUser,
    ip: string | null = null,
  ): Promise<{ retriedCount: number }> {
    requireCapability(user, 'settings.manage');

    return this.db.transaction(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `WITH target AS (
           SELECT id FROM outbox_events
           WHERE status = 'dead_letter'
           ORDER BY created_at ASC
           LIMIT 500
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events o
         SET status = 'pending',
             attempts = 0,
             retry_count = o.retry_count + 1,
             available_at = NOW(),
             last_error = NULL
         FROM target
         WHERE o.id = target.id
         RETURNING o.id`,
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'outbox.dead_letter_retried_all',
        entityType: 'outbox_event',
        entityId: 'batch',
        metadata: { retriedCount: res.rowCount },
        ipAddress: ip,
      });

      return { retriedCount: res.rowCount };
    });
  }

  async purgeDeadLetterEvent(
    user: SessionUser,
    eventId: string,
    ip: string | null = null,
  ): Promise<{ deleted: true; id: string }> {
    requireCapability(user, 'settings.manage');

    return this.db.transaction(async (tx) => {
      const res = await tx.query<{
        id: string;
        event_type: string;
        aggregate_type: string;
        attempts: number;
        retry_count: number;
        last_error: string | null;
      }>(
        `DELETE FROM outbox_events
         WHERE id = $1 AND status = 'dead_letter'
         RETURNING id, event_type, aggregate_type, attempts, retry_count, last_error`,
        [eventId],
      );
      const removed = res.rows[0];
      if (!removed) {
        throw new NotFoundDomainError('Dead-letter outbox event', eventId);
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'outbox.dead_letter_purged',
        entityType: 'outbox_event',
        entityId: removed.id,
        metadata: {
          eventType: removed.event_type,
          aggregateType: removed.aggregate_type,
          attempts: removed.attempts,
          retryCount: removed.retry_count,
          lastError: removed.last_error,
        },
        ipAddress: ip,
      });

      return { deleted: true, id: removed.id };
    });
  }

  /** Records a backup or restore-drill run for `/healthz` and operational dashboards. */
  async recordBackupRun(input: {
    id?: string;
    kind: 'pg_dump' | 'wal_base' | 'files_snapshot' | 'restore_drill' | 'pre_deploy';
    status: 'running' | 'succeeded' | 'failed';
    artifactKey?: string | null;
    sizeBytes?: bigint | number | null;
    checksumSha256?: string | null;
    encrypted?: boolean;
    offsiteSynced?: boolean;
    startedAt?: Date;
    completedAt?: Date | null;
    durationMs?: number | null;
    errorCode?: string | null;
    details?: Record<string, unknown>;
  }): Promise<string> {
    const id = input.id ?? `bkp_${randomUUID()}`;
    await this.db.query(
      `INSERT INTO backup_runs (
         id, kind, status, artifact_key, size_bytes, checksum_sha256,
         encrypted, offsite_synced, started_at, completed_at, duration_ms, error_code, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()), $10, $11, $12, $13::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           artifact_key = COALESCE(EXCLUDED.artifact_key, backup_runs.artifact_key),
           size_bytes = COALESCE(EXCLUDED.size_bytes, backup_runs.size_bytes),
           checksum_sha256 = COALESCE(EXCLUDED.checksum_sha256, backup_runs.checksum_sha256),
           encrypted = EXCLUDED.encrypted,
           offsite_synced = EXCLUDED.offsite_synced,
           completed_at = EXCLUDED.completed_at,
           duration_ms = EXCLUDED.duration_ms,
           error_code = EXCLUDED.error_code,
           details = EXCLUDED.details`,
      [
        id,
        input.kind,
        input.status,
        input.artifactKey ?? null,
        input.sizeBytes === null || input.sizeBytes === undefined ? null : String(input.sizeBytes),
        input.checksumSha256 ?? null,
        input.encrypted ?? true,
        input.offsiteSynced ?? false,
        input.startedAt ? input.startedAt.toISOString() : null,
        input.completedAt ? input.completedAt.toISOString() : null,
        input.durationMs ?? null,
        input.errorCode ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    return id;
  }
}
