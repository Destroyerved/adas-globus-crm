import { z } from 'zod';

/**
 * Shared schemas and types for deep `/healthz` readiness checks, background worker
 * heartbeats, dead-letter outbox queue administration, and backup run telemetry
 * (PRD 6.9, 10.5, 10.6, 11 Phase 1).
 */

export const HealthCheckResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  service: z.literal('adas-crm-api'),
  mailLive: z.boolean(),
  devLoginEnabled: z.boolean(),
  uptimeSeconds: z.number().int().nonnegative(),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      latencyMs: z.number().nonnegative().nullable(),
    }),
    outbox: z.object({
      ok: z.boolean(),
      pendingCount: z.number().int().nonnegative(),
      oldestPendingSeconds: z.number().int().nonnegative().nullable(),
      deadLetterCount: z.number().int().nonnegative(),
    }),
    worker: z.object({
      state: z.enum(['active', 'idle', 'stale']),
      activeWorkers: z.number().int().nonnegative(),
      lastHeartbeatSecondsAgo: z.number().int().nonnegative().nullable(),
      lastOutboxDispatchSecondsAgo: z.number().int().nonnegative().nullable(),
    }),
    backups: z.object({
      state: z.enum(['ok', 'stale', 'unrecorded']),
      lastBackupHoursAgo: z.number().nonnegative().nullable(),
      lastRestoreDrillDaysAgo: z.number().nonnegative().nullable(),
    }),
    mailSync: z.object({
      expiringSubscriptions: z.number().int().nonnegative(),
    }),
  }),
});
export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

export const WorkerHeartbeatViewSchema = z.object({
  worker_id: z.string(),
  hostname: z.string(),
  pid: z.number().int(),
  status: z.enum(['running', 'draining', 'stopped']),
  active_jobs: z.number().int().nonnegative(),
  started_at: z.string(),
  last_heartbeat_at: z.string(),
  last_job_name: z.string().nullable(),
  last_job_at: z.string().nullable(),
  last_outbox_dispatch_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
});
export type WorkerHeartbeatView = z.infer<typeof WorkerHeartbeatViewSchema>;

export const DeadLetterEventViewSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  attempts: z.number().int().nonnegative(),
  retry_count: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  available_at: z.string(),
});
export type DeadLetterEventView = z.infer<typeof DeadLetterEventViewSchema>;

export const BackupRunViewSchema = z.object({
  id: z.string(),
  kind: z.enum(['pg_dump', 'wal_base', 'files_snapshot', 'restore_drill', 'pre_deploy']),
  status: z.enum(['running', 'succeeded', 'failed']),
  size_bytes: z.string().nullable(),
  encrypted: z.boolean(),
  offsite_synced: z.boolean(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  error_code: z.string().nullable(),
});
export type BackupRunView = z.infer<typeof BackupRunViewSchema>;

export const SystemHealthOverviewSchema = z.object({
  readiness: HealthCheckResponseSchema,
  process: z.object({
    nodeVersion: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    rssBytes: z.number().int().nonnegative(),
    heapUsedBytes: z.number().int().nonnegative(),
  }),
  queues: z.object({
    pgBossInstalled: z.boolean(),
    outboxPending: z.number().int().nonnegative(),
    outboxProcessed24h: z.number().int().nonnegative(),
    outboxDeadLetter: z.number().int().nonnegative(),
    oldestPendingSeconds: z.number().int().nonnegative().nullable(),
    webhooksPending: z.number().int().nonnegative(),
    webhooksRetrying: z.number().int().nonnegative(),
    webhooksFailed24h: z.number().int().nonnegative(),
  }),
  workers: z.array(WorkerHeartbeatViewSchema),
  deadLetters: z.array(DeadLetterEventViewSchema),
  backups: z.array(BackupRunViewSchema),
});
export type SystemHealthOverview = z.infer<typeof SystemHealthOverviewSchema>;
