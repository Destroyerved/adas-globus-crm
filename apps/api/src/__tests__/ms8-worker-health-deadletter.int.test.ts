import { mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HealthCheckResponseSchema,
  SystemHealthOverviewSchema,
  type HealthCheckResponse,
  type SystemHealthOverview,
} from '@adas/shared';
import { buildWorker } from '../jobs.js';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { LocalFileStorage } from '../platform/files/index.js';
import { JobRunner } from '../platform/jobs/index.js';
import { createLogger } from '../platform/logger/index.js';

describe('Milestone 8: Worker heartbeats, graceful drain, deep /healthz & dead-letter Admin queue (PRD 6.9, 10.5, 10.6, 11 Phase 1)', () => {
  let db: DatabaseService;
  let apiServer: Server;
  let apiBaseUrl = '';
  let tempFilesDir = '';
  const secretBox = SecretBox.ephemeral();

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    tempFilesDir = mkdtempSync(join(tmpdir(), 'adas-ms8-'));

    const env = validateEnv({
      NODE_ENV: 'test',
      PUBLIC_WEB_URL: 'http://localhost:5174',
      LOG_LEVEL: 'error',
    });
    const app = createAppServer(env, db, {
      secretBox,
      files: new LocalFileStorage(tempFilesDir),
    });
    apiServer = app.server;
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const port = (apiServer.address() as AddressInfo).port;
    apiBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (apiServer) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await db?.close();
    if (tempFilesDir) rmSync(tempFilesDir, { recursive: true, force: true });
  });

  async function loginCookie(userId: string): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Host: 'crm.adasglobuspro.com',
      },
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? '';
    return setCookie.split(';')[0] ?? '';
  }

  it('tracks worker heartbeats, drains in-flight jobs on stop(), and surfaces backup/worker health on /healthz', async () => {
    // 1. Baseline /healthz returns 200 ok with structured checks and zero host/PID leaks
    const initialRes = await fetch(`${apiBaseUrl}/healthz`, {
      headers: { Host: 'go.adasglobuspro.com' },
    });
    expect(initialRes.status).toBe(200);
    const initialBody = (await initialRes.json()) as HealthCheckResponse;
    expect(HealthCheckResponseSchema.safeParse(initialBody).success).toBe(true);
    expect(initialBody.status).toBe('ok');
    expect(initialBody.checks.database.ok).toBe(true);
    expect(initialBody.checks.worker.state).toBe('idle');
    expect(initialBody.checks.worker.lastHeartbeatSecondsAgo).toBeNull();
    expect(initialBody.checks.backups.state).toBe('unrecorded');
    expect(initialBody.checks.backups.lastBackupHoursAgo).toBeNull();
    expect(JSON.stringify(initialBody)).not.toContain('pid');
    expect(JSON.stringify(initialBody)).not.toContain('hostname');

    // 2. Start a JobRunner with a slow job to prove heartbeat registration + graceful drain on stop()
    const logger = createLogger('error');
    let slowJobStarted = false;
    let slowJobCompletedBeforeStopReturned = false;

    const runner = new JobRunner(
      db,
      logger,
      [
        {
          name: 'outbox.dispatch',
          run: async () => ({ processed: 1 }),
        },
        {
          name: 'housekeeping.purge',
          run: async () => {
            slowJobStarted = true;
            await new Promise((r) => setTimeout(r, 250));
            slowJobCompletedBeforeStopReturned = true;
            return { drained: 1 };
          },
        },
      ],
      {
        install: true,
        workerId: 'wrk_ms8_test_1',
        heartbeatIntervalSeconds: 2,
      },
    );

    await runner.start();
    await runner.trigger('outbox.dispatch');
    await runner.idle('outbox.dispatch');

    // /healthz now sees an active worker with recent outbox.dispatch
    const activeRes = await fetch(`${apiBaseUrl}/api/v1/healthz`);
    const activeBody = (await activeRes.json()) as HealthCheckResponse;
    expect(activeBody.status).toBe('ok');
    expect(activeBody.checks.worker.state).toBe('active');
    expect(activeBody.checks.worker.activeWorkers).toBeGreaterThanOrEqual(1);
    expect(activeBody.checks.worker.lastOutboxDispatchSecondsAgo).not.toBeNull();

    // Trigger the slow job, wait until it starts executing, then call stop() -> must drain cleanly!
    await runner.trigger('housekeeping.purge');
    const waitStart = Date.now();
    while (!slowJobStarted && Date.now() - waitStart < 5_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(slowJobStarted).toBe(true);

    await runner.stop();
    expect(slowJobCompletedBeforeStopReturned).toBe(true);

    const hbRow = await db.query<{ status: string; active_jobs: number; stopped_at: Date | null }>(
      `SELECT status, active_jobs, stopped_at FROM worker_heartbeats WHERE worker_id = 'wrk_ms8_test_1'`,
    );
    expect(hbRow.rows[0]?.status).toBe('stopped');
    expect(hbRow.rows[0]?.active_jobs).toBe(0);
    expect(hbRow.rows[0]?.stopped_at).not.toBeNull();

    // 3. Simulate a crashed running worker (> 60s old) and a stale backup (> 26h old) -> strict=1 returns 503 degraded
    await db.query(
      `INSERT INTO worker_heartbeats (worker_id, hostname, pid, status, active_jobs, started_at, last_heartbeat_at)
       VALUES ('wrk_crashed_node', 'crm-worker-1', 4242, 'running', 1, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '3 minutes')`,
    );
    await db.query(
      `INSERT INTO backup_runs (id, kind, status, size_bytes, encrypted, offsite_synced, started_at, completed_at, duration_ms)
       VALUES ('bkp_stale_1', 'pg_dump', 'succeeded', 10485760, TRUE, TRUE, NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours', 4200)`,
    );

    const strictStaleRes = await fetch(`${apiBaseUrl}/healthz?strict=1`);
    expect(strictStaleRes.status).toBe(503);
    const strictStaleBody = (await strictStaleRes.json()) as HealthCheckResponse;
    expect(strictStaleBody.status).toBe('degraded');
    expect(strictStaleBody.checks.worker.state).toBe('stale');
    expect(strictStaleBody.checks.backups.state).toBe('stale');

    // Clean up stale test worker and record a fresh backup + restore drill -> returns to 200 ok
    await db.query(`DELETE FROM worker_heartbeats WHERE worker_id = 'wrk_crashed_node'`);
    await db.query(
      `INSERT INTO backup_runs (id, kind, status, size_bytes, encrypted, offsite_synced, started_at, completed_at, duration_ms)
       VALUES ('bkp_fresh_1', 'pg_dump', 'succeeded', 12582912, TRUE, TRUE, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 3800),
              ('bkp_drill_1', 'restore_drill', 'succeeded', 12582912, TRUE, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', 19400)`,
    );

    const recoveredRes = await fetch(`${apiBaseUrl}/healthz?strict=1`);
    expect(recoveredRes.status).toBe(200);
    const recoveredBody = (await recoveredRes.json()) as HealthCheckResponse;
    expect(recoveredBody.status).toBe('ok');
    expect(recoveredBody.checks.backups.state).toBe('ok');
    expect(recoveredBody.checks.backups.lastRestoreDrillDaysAgo).not.toBeNull();
  });

  it('alerts Admins on outbox dead-letter with zero PII, enforces settings.manage, and audits retry & purge', async () => {
    const adminCookie = await loginCookie('usr_admin_1');
    const repCookie = await loginCookie('usr_ae_1');

    // 1. Non-admin (Sales Executive) cannot access /api/v1/admin/system-health
    const forbiddenRes = await fetch(`${apiBaseUrl}/api/v1/admin/system-health`, {
      headers: {
        Cookie: repCookie,
        Host: 'crm.adasglobuspro.com',
      },
    });
    expect(forbiddenRes.status).toBe(403);

    // 2. Build a worker with maxOutboxAttempts = 2 and register a failing handler on a test event
    const logger = createLogger('error');
    const worker = buildWorker(db, logger, {
      files: new LocalFileStorage(tempFilesDir),
      secretBox,
      maxOutboxAttempts: 2,
    });

    let shouldFailHandler = true;
    let handledAfterRetry = 0;
    worker.outbox.on('ms8.dlq_probe', async () => {
      if (shouldFailHandler) {
        const err = new Error('Downstream timeout for sensitive.person@firm.example.com');
        (err as Error & { code?: string }).code = 'ETIMEDOUT';
        throw err;
      }
      handledAfterRetry += 1;
    });

    await db.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status, available_at)
       VALUES ('evt_ms8_dlq_1', 'ms8.dlq_probe', 'deal', 'deal_ms8_1', $1::jsonb, 'pending', NOW())`,
      [JSON.stringify({ secretEmail: 'sensitive.person@firm.example.com' })],
    );

    // Attempt 1 -> retried
    const d1 = await worker.outbox.dispatch();
    expect(d1.retried).toBe(1);
    expect(d1.deadLettered).toBe(0);

    // Fast-forward available_at for Attempt 2 -> moves to dead_letter and alerts active Admins!
    await db.query(`UPDATE outbox_events SET available_at = NOW() WHERE id = 'evt_ms8_dlq_1'`);
    const d2 = await worker.outbox.dispatch();
    expect(d2.deadLettered).toBe(1);

    // Verify Admin received in-app security notification, Sales Executive did NOT, and zero PII is stored
    const notifRes = await db.query<{ user_id: string; kind: string; title: string; body: string }>(
      `SELECT user_id, kind, title, body FROM notifications WHERE entity_id = 'evt_ms8_dlq_1'`,
    );
    expect(notifRes.rows.length).toBeGreaterThanOrEqual(1);
    expect(notifRes.rows.some((n) => n.user_id === 'usr_admin_1')).toBe(true);
    expect(notifRes.rows.some((n) => n.user_id === 'usr_ae_1')).toBe(false);
    for (const n of notifRes.rows) {
      expect(n.kind).toBe('security');
      expect(n.body).toContain('ms8.dlq_probe');
      expect(n.body).toContain('Error ETIMEDOUT');
      expect(n.body).not.toContain('sensitive.person@firm.example.com');
    }

    // 3. Admin reads /api/v1/admin/system-health -> sees dead-letter row with zero payload PII
    const overviewRes = await fetch(`${apiBaseUrl}/api/v1/admin/system-health`, {
      headers: {
        Cookie: adminCookie,
        Host: 'crm.adasglobuspro.com',
      },
    });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as SystemHealthOverview;
    expect(SystemHealthOverviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.readiness.status).toBe('degraded');
    expect(overview.queues.outboxDeadLetter).toBeGreaterThanOrEqual(1);
    const dlqItem = overview.deadLetters.find((d) => d.id === 'evt_ms8_dlq_1');
    expect(dlqItem).toBeDefined();
    expect(dlqItem?.last_error).toBe('Error ETIMEDOUT');
    expect(JSON.stringify(overview)).not.toContain('sensitive.person@firm.example.com');

    // 4. Admin retries evt_ms8_dlq_1 -> resets to pending, increments retry_count, writes audit log, and succeeds!
    shouldFailHandler = false;
    const retryRes = await fetch(`${apiBaseUrl}/api/v1/admin/outbox/evt_ms8_dlq_1/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminCookie,
        Origin: 'http://localhost:5174',
        Host: 'crm.adasglobuspro.com',
      },
      body: JSON.stringify({}),
    });
    expect(retryRes.status).toBe(200);
    const retriedBody = (await retryRes.json()) as {
      id: string;
      status: string;
      retryCount: number;
    };
    expect(retriedBody.retryCount).toBe(1);

    const d3 = await worker.outbox.dispatch();
    expect(d3.processed).toBeGreaterThanOrEqual(1);
    expect(handledAfterRetry).toBe(1);

    // 5. Insert an unrecoverable dead-letter event and purge it via DELETE /api/v1/admin/outbox/:id
    await db.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, status, attempts, last_error)
       VALUES ('evt_ms8_dlq_purge', 'ms8.corrupt_event', 'lead', 'lead_ms8_9', 'dead_letter', 10, 'ValidationError')`,
    );

    const purgeRes = await fetch(`${apiBaseUrl}/api/v1/admin/outbox/evt_ms8_dlq_purge`, {
      method: 'DELETE',
      headers: {
        Cookie: adminCookie,
        Origin: 'http://localhost:5174',
        Host: 'crm.adasglobuspro.com',
      },
    });
    expect(purgeRes.status).toBe(200);

    const auditRes = await db.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_logs
       WHERE action IN ('outbox.dead_letter_retried', 'outbox.dead_letter_purged')
       ORDER BY created_at ASC`,
    );
    expect(
      auditRes.rows.some(
        (r) => r.action === 'outbox.dead_letter_retried' && r.entity_id === 'evt_ms8_dlq_1',
      ),
    ).toBe(true);
    expect(
      auditRes.rows.some(
        (r) => r.action === 'outbox.dead_letter_purged' && r.entity_id === 'evt_ms8_dlq_purge',
      ),
    ).toBe(true);
  });
});
