import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorker, purgeExpired } from '../jobs.js';
import { DatabaseService } from '../platform/db/index.js';
import { createLogger } from '../platform/logger/index.js';
import { OutboxDispatcher } from '../platform/outbox/index.js';
import { MemoryFileStorage } from '../platform/files/index.js';
import { CrmJobs } from '../modules/crm/index.js';

/**
 * The background worker (PRD 4.6, 4.7, 4.10, 4.16, 6.9): every sweep does its work once,
 * a second run changes nothing, and pg-boss runs the jobs on the app's own database.
 */

let db: DatabaseService;
let crm: CrmJobs;
const logger = createLogger('silent');

beforeAll(async () => {
  db = DatabaseService.forTests();
  await db.ensureInitialized();
  crm = new CrmJobs(db);
});

afterAll(async () => {
  await db.close();
});

async function notificationsFor(userId: string, dedupePrefix: string) {
  const res = await db.query<{ kind: string; title: string; entity_type: string | null }>(
    `SELECT kind, title, entity_type FROM notifications
     WHERE user_id = $1 AND dedupe_key LIKE $2 ORDER BY created_at`,
    [userId, `${dedupePrefix}%`],
  );
  return res.rows;
}

async function addTask(id: string, fields: Record<string, string>) {
  await db.query(
    `INSERT INTO tasks (id, title, task_type, priority, status, due_at, reminder_at,
       assignee_user_id, team_id, lead_id)
     VALUES ($1, $2, $3, 'normal', 'open', ${fields['due']}, ${fields['reminder'] ?? 'NULL'},
       $4, 'team_us', 'lead_jane')`,
    [id, fields['title'] ?? 'Call back', fields['type'] ?? 'follow_up', fields['assignee']],
  );
}

describe('task reminders and overdue alerts (PRD 4.7, 4.16)', () => {
  it('sends a due reminder once, and again only when the reminder time changes', async () => {
    await addTask('tsk_w_rem', {
      title: 'Send the proposal',
      due: `NOW() + INTERVAL '1 hour'`,
      reminder: `NOW() - INTERVAL '1 minute'`,
      assignee: 'usr_bdr_2',
    });
    await crm.sendTaskReminders();
    let sent = await notificationsFor('usr_bdr_2', 'task_reminder:tsk_w_rem:');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'task_reminder', entity_type: 'lead' });
    expect(sent[0]?.title).toBe('Reminder: Send the proposal');

    expect((await crm.sendTaskReminders()).reminders).toBe(0);
    expect(await notificationsFor('usr_bdr_2', 'task_reminder:tsk_w_rem:')).toHaveLength(1);

    // Editing the reminder clears reminder_sent_at (records.ts), so the new time fires too.
    await db.query(
      `UPDATE tasks SET reminder_at = NOW() - INTERVAL '5 seconds', reminder_sent_at = NULL
       WHERE id = 'tsk_w_rem'`,
    );
    await crm.sendTaskReminders();
    sent = await notificationsFor('usr_bdr_2', 'task_reminder:tsk_w_rem:');
    expect(sent).toHaveLength(2);
  });

  it('does not remind about done or deleted tasks, or before the reminder time', async () => {
    await addTask('tsk_w_future', {
      due: `NOW() + INTERVAL '2 days'`,
      reminder: `NOW() + INTERVAL '1 day'`,
      assignee: 'usr_bdr_2',
    });
    await addTask('tsk_w_done', {
      due: `NOW() + INTERVAL '1 hour'`,
      reminder: `NOW() - INTERVAL '1 minute'`,
      assignee: 'usr_bdr_2',
    });
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = 'tsk_w_done'`);
    await crm.sendTaskReminders();
    expect(await notificationsFor('usr_bdr_2', 'task_reminder:tsk_w_future:')).toHaveLength(0);
    expect(await notificationsFor('usr_bdr_2', 'task_reminder:tsk_w_done:')).toHaveLength(0);
  });

  it('notifies an overdue task once and emits task.overdue', async () => {
    await addTask('tsk_w_late', {
      title: 'Chase the signed MSA',
      due: `NOW() - INTERVAL '2 hours'`,
      assignee: 'usr_ae_1',
    });
    await crm.notifyOverdueTasks();
    const sent = await notificationsFor('usr_ae_1', 'task_overdue:tsk_w_late:');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('Overdue: Chase the signed MSA');
    const events = await db.query(
      `SELECT 1 FROM outbox_events WHERE event_type = 'task.overdue' AND aggregate_id = 'tsk_w_late'`,
    );
    expect(events.rows).toHaveLength(1);

    expect((await crm.notifyOverdueTasks()).overdue).toBe(0);
    expect(await notificationsFor('usr_ae_1', 'task_overdue:tsk_w_late:')).toHaveLength(1);
  });
});

describe('inquiry SLA (PRD 4.10, 4.16)', () => {
  it('warns four hours before the deadline, once', async () => {
    // Seeded: tsk_sla_1 (manager) is due in 15 minutes.
    await crm.checkInquirySla();
    expect(await notificationsFor('usr_mgr_1', 'sla_warning:tsk_sla_1')).toHaveLength(1);
    const again = await crm.checkInquirySla();
    expect(again.warned).toBe(0);
    expect(await notificationsFor('usr_mgr_1', 'sla_warning:tsk_sla_1')).toHaveLength(1);
  });

  it('marks a missed deadline breached and tells the assignee and the team managers', async () => {
    await db.query(
      `INSERT INTO tasks (id, title, task_type, priority, status, due_at, sla_deadline_at,
         assignee_user_id, team_id, lead_id)
       VALUES ('tsk_w_sla', 'First response SLA', 'sla_first_response', 'urgent', 'open',
         NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'usr_bdr_2', 'team_us', 'lead_jane')`,
    );
    await crm.checkInquirySla();
    const task = await db.query<{ sla_breached: boolean }>(
      `SELECT sla_breached FROM tasks WHERE id = 'tsk_w_sla'`,
    );
    expect(task.rows[0]?.sla_breached).toBe(true);
    // team_us: the BDR, the Sales Manager and the Admin; not the Canadian team.
    for (const userId of ['usr_bdr_2', 'usr_mgr_1', 'usr_admin_1']) {
      expect(await notificationsFor(userId, 'sla_breach:tsk_w_sla:')).toHaveLength(1);
    }
    expect(await notificationsFor('usr_bdr_1', 'sla_breach:tsk_w_sla:')).toHaveLength(0);
    // Not also an ordinary overdue alert.
    await crm.notifyOverdueTasks();
    expect(await notificationsFor('usr_bdr_2', 'task_overdue:tsk_w_sla:')).toHaveLength(0);

    expect((await crm.checkInquirySla()).breached).toBe(0);
    expect(await notificationsFor('usr_mgr_1', 'sla_breach:tsk_w_sla:')).toHaveLength(1);
  });
});

describe('idle deals (PRD 4.6)', () => {
  it('flags a deal once per quiet spell', async () => {
    // Ridgeway (Proposal Sent, idle after 14 days) owned by the Account Executive.
    await db.query(
      `UPDATE deals SET last_activity_at = NOW() - INTERVAL '30 days', idle_flagged_at = NULL
       WHERE id = 'deal_ridgeway_audit'`,
    );
    await crm.flagIdleDeals();
    let sent = await notificationsFor('usr_ae_1', 'deal_idle:deal_ridgeway_audit:');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toMatch(/^Idle for 30 days: /);
    expect((await crm.flagIdleDeals()).idle).toBe(0);

    // Activity after the flag starts a new spell; when that goes quiet too, it flags again.
    await db.query(
      `UPDATE deals SET idle_flagged_at = NOW() - INTERVAL '25 days',
         last_activity_at = NOW() - INTERVAL '20 days'
       WHERE id = 'deal_ridgeway_audit'`,
    );
    await crm.flagIdleDeals();
    sent = await notificationsFor('usr_ae_1', 'deal_idle:deal_ridgeway_audit:');
    expect(sent).toHaveLength(2);
  });

  it('leaves recently active and closed deals alone', async () => {
    await crm.flagIdleDeals();
    expect(await notificationsFor('usr_mgr_1', 'deal_idle:deal_acme_tax:')).toHaveLength(0);
    expect(await notificationsFor('usr_mgr_1', 'deal_idle:deal_clearwater_won:')).toHaveLength(0);
  });
});

describe('outbox dispatch (PRD 6.9)', () => {
  async function addEvent(id: string, type: string) {
    await db.transaction((tx) =>
      db.addOutboxEvent(tx, {
        id,
        eventType: type,
        aggregateType: 'test',
        aggregateId: id,
        payload: { n: 1 },
      }),
    );
  }

  it('runs handlers in the same transaction and marks the event processed', async () => {
    const seen: string[] = [];
    const outbox = new OutboxDispatcher(db, logger).on('test.ping', async (event, tx) => {
      seen.push(event.id);
      await tx.query(`UPDATE users SET daily_send_cap = daily_send_cap WHERE id = 'usr_admin_1'`);
    });
    await addEvent('evt_w_ok', 'test.ping');
    await outbox.dispatch();
    expect(seen).toEqual(['evt_w_ok']);
    const row = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox_events WHERE id = 'evt_w_ok'`,
    );
    expect(row.rows[0]).toEqual({ status: 'processed', attempts: 1 });
    await outbox.dispatch();
    expect(seen).toEqual(['evt_w_ok']);
  });

  it('rolls back a failed handler, backs off, and dead-letters after the last attempt', async () => {
    const outbox = new OutboxDispatcher(db, logger, 2).on('test.fail', async (_event, tx) => {
      await tx.query(`UPDATE users SET name = 'Changed' WHERE id = 'usr_ro_1'`);
      throw new TypeError('handler failed for jane@example.com');
    });
    await addEvent('evt_w_fail', 'test.fail');
    expect((await outbox.dispatch()).retried).toBe(1);
    const first = await db.query<{
      status: string;
      attempts: number;
      last_error: string;
      later: boolean;
    }>(
      `SELECT status, attempts, last_error, available_at > NOW() AS later
       FROM outbox_events WHERE id = 'evt_w_fail'`,
    );
    // No personal data from the error message is stored.
    expect(first.rows[0]).toEqual({
      status: 'pending',
      attempts: 1,
      last_error: 'TypeError',
      later: true,
    });
    const name = await db.query<{ name: string }>(`SELECT name FROM users WHERE id = 'usr_ro_1'`);
    expect(name.rows[0]?.name).not.toBe('Changed');

    // Not retried before its backoff; then dead-lettered on the second failure.
    expect((await outbox.dispatch()).retried).toBe(0);
    await db.query(`UPDATE outbox_events SET available_at = NOW() WHERE id = 'evt_w_fail'`);
    expect((await outbox.dispatch()).deadLettered).toBe(1);
    const last = await db.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE id = 'evt_w_fail'`,
    );
    expect(last.rows[0]?.status).toBe('dead_letter');
  });
});

describe('housekeeping', () => {
  it('purges expired idempotency keys and long-ended sessions only', async () => {
    await db.query(
      `INSERT INTO idempotency_keys (key, actor_id, method, path, status_code, response_json, created_at)
       VALUES ('old-key', 'usr_admin_1', 'POST', '/api/v1/leads', 201, '{}', NOW() - INTERVAL '2 days'),
              ('new-key', 'usr_admin_1', 'POST', '/api/v1/leads', 201, '{}', NOW())`,
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at)
       VALUES ('ses_w_old', 'usr_admin_1', 'x', NOW() - INTERVAL '40 days', NOW() - INTERVAL '47 days'),
              ('ses_w_live', 'usr_admin_1', 'x', NOW() + INTERVAL '1 day', NOW())`,
    );
    const result = await purgeExpired(db);
    expect(result.idempotencyKeys).toBeGreaterThanOrEqual(1);
    const keys = await db.query<{ key: string }>(
      `SELECT key FROM idempotency_keys WHERE key IN ('old-key', 'new-key')`,
    );
    expect(keys.rows.map((r) => r.key)).toEqual(['new-key']);
    const sessions = await db.query<{ id: string }>(
      `SELECT id FROM sessions WHERE id IN ('ses_w_old', 'ses_w_live')`,
    );
    expect(sessions.rows.map((r) => r.id)).toEqual(['ses_w_live']);
  });
});

describe('the worker on pg-boss', () => {
  it('installs its queues and runs a job end to end', async () => {
    const { runner } = buildWorker(db, logger, { install: true, files: new MemoryFileStorage() });
    await runner.start();
    try {
      await addTask('tsk_w_boss', {
        due: `NOW() + INTERVAL '1 hour'`,
        reminder: `NOW() - INTERVAL '1 second'`,
        assignee: 'usr_bdr_1',
      });
      expect(await runner.trigger('tasks.reminders')).not.toBeNull();
      await runner.idle('tasks.reminders');
      expect(await notificationsFor('usr_bdr_1', 'task_reminder:tsk_w_boss:')).toHaveLength(1);
      const queues = await db.query<{ name: string }>(
        // pg-boss keeps its own internal queues under the `__pgboss__` prefix.
        `SELECT name FROM pgboss.queue WHERE name NOT LIKE '\\_\\_pgboss\\_\\_%' ORDER BY name`,
      );
      expect(queues.rows.map((q) => q.name)).toEqual([
        'bulk.execute',
        'campaign.tick',
        'deals.idle',
        'duplicates.scan',
        'export.build',
        'housekeeping.purge',
        'import.process',
        'mail.subscriptions.renew',
        'mail.sync',
        'outbox.dispatch',
        'sequence.tick',
        'sla.check',
        'tasks.reminders',
        'webhook.deliver',
      ]);
    } finally {
      await runner.stop();
    }
  }, 30_000);
});
