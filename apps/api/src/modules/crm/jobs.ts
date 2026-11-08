import { formatDateTime } from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import { addNotification } from '../notifications/index.js';

/**
 * Background sweeps for tasks, inquiries and deals (PRD 4.6, 4.7, 4.10, 4.16; job catalogue
 * in PRD 6.9). Each sweep claims at most BATCH rows with FOR UPDATE SKIP LOCKED inside one
 * transaction, records what it did on the row itself and notifies with a dedupe key, so a
 * retried or doubled run never notifies twice.
 */

const BATCH = 500;

const epoch = (at: string | Date) => new Date(at).getTime();

/** Where a task's notification should open: its record, or the tasks list. */
function taskTarget(t: {
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
}): { entityType: string; entityId: string | null } {
  if (t.deal_id) return { entityType: 'deal', entityId: t.deal_id };
  if (t.lead_id) return { entityType: 'lead', entityId: t.lead_id };
  if (t.contact_id) return { entityType: 'contact', entityId: t.contact_id };
  if (t.company_id) return { entityType: 'company', entityId: t.company_id };
  return { entityType: 'task', entityId: null };
}

interface TaskRow {
  id: string;
  title: string;
  task_type: string;
  assignee_user_id: string;
  assignee_timezone: string;
  team_id: string | null;
  due_at: string;
  reminder_at: string | null;
  sla_deadline_at: string | null;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  related_name: string | null;
}

const TASK_SELECT = `SELECT t.id, t.title, t.task_type, t.assignee_user_id,
    au.timezone AS assignee_timezone, t.team_id, t.due_at::text AS due_at,
    t.reminder_at::text AS reminder_at, t.sla_deadline_at::text AS sla_deadline_at,
    t.lead_id, t.contact_id, t.company_id, t.deal_id,
    COALESCE(ld.full_name, ct.full_name, dl.name, cmp.name) AS related_name
  FROM tasks t
  JOIN users au ON au.id = t.assignee_user_id
  LEFT JOIN leads ld ON ld.id = t.lead_id
  LEFT JOIN contacts ct ON ct.id = t.contact_id
  LEFT JOIN deals dl ON dl.id = t.deal_id
  LEFT JOIN companies cmp ON cmp.id = t.company_id`;

/** Active managers of a team: people whose role is Sales Manager or Admin in that team. */
async function teamManagers(tx: DbTx, teamId: string | null): Promise<string[]> {
  if (!teamId) return [];
  const res = await tx.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.team_id = $1 AND u.status = 'active' AND r.name IN ('Sales Manager', 'Admin')`,
    [teamId],
  );
  return res.rows.map((r) => r.id);
}

const about = (t: TaskRow) => (t.related_name ? ` · ${t.related_name}` : '');

export class CrmJobs {
  constructor(private readonly db: DatabaseService) {}

  /** `tasks.reminders` (every minute): reminders that are due, once per reminder time. */
  async sendTaskReminders(): Promise<{ reminders: number }> {
    return this.db.transaction(async (tx) => {
      const due = await tx.query<TaskRow>(
        `${TASK_SELECT}
         WHERE t.reminder_at <= NOW() AND t.reminder_sent_at IS NULL
           AND t.status = 'open' AND t.deleted_at IS NULL
         ORDER BY t.reminder_at LIMIT ${BATCH}
         FOR UPDATE OF t SKIP LOCKED`,
        [],
      );
      let reminders = 0;
      for (const t of due.rows) {
        const sent = await addNotification(tx, {
          userId: t.assignee_user_id,
          kind: 'task_reminder',
          title: `Reminder: ${t.title}`,
          body: `Due ${formatDateTime(t.due_at, t.assignee_timezone)}${about(t)}.`,
          ...taskTarget(t),
          dedupeKey: `task_reminder:${t.id}:${epoch(t.reminder_at ?? t.due_at)}`,
        });
        await tx.query(`UPDATE tasks SET reminder_sent_at = NOW() WHERE id = $1`, [t.id]);
        if (sent) reminders += 1;
      }
      return { reminders };
    });
  }

  /**
   * `tasks.reminders` (every minute): open tasks that just became overdue notify their
   * assignee once and emit `task.overdue`. First-reply inquiries are left to the SLA check.
   */
  async notifyOverdueTasks(): Promise<{ overdue: number }> {
    return this.db.transaction(async (tx) => {
      const due = await tx.query<TaskRow>(
        `${TASK_SELECT}
         WHERE t.due_at < NOW() AND t.overdue_notified_at IS NULL
           AND t.status = 'open' AND t.deleted_at IS NULL
           AND t.task_type <> 'sla_first_response'
         ORDER BY t.due_at LIMIT ${BATCH}
         FOR UPDATE OF t SKIP LOCKED`,
        [],
      );
      let overdue = 0;
      for (const t of due.rows) {
        const sent = await addNotification(tx, {
          userId: t.assignee_user_id,
          kind: 'task_overdue',
          title: `Overdue: ${t.title}`,
          body: `It was due ${formatDateTime(t.due_at, t.assignee_timezone)}${about(t)}.`,
          ...taskTarget(t),
          dedupeKey: `task_overdue:${t.id}:${epoch(t.due_at)}`,
        });
        await tx.query(`UPDATE tasks SET overdue_notified_at = NOW() WHERE id = $1`, [t.id]);
        if (sent) {
          overdue += 1;
          await this.db.addOutboxEvent(tx, {
            eventType: 'task.overdue',
            aggregateType: 'task',
            aggregateId: t.id,
            payload: { id: t.id, assigneeUserId: t.assignee_user_id, dueAt: t.due_at },
          });
        }
      }
      return { overdue };
    });
  }

  /**
   * `sla.check` (every 5 minutes): a website inquiry still waiting for a first reply warns its
   * assignee four hours before the deadline (PRD 4.16) and, once the deadline passes, is
   * marked breached and notifies the assignee and the team's managers.
   */
  async checkInquirySla(): Promise<{ warned: number; breached: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<TaskRow & { breached_now: boolean }>(
        `${TASK_SELECT.replace('SELECT', 'SELECT (t.sla_deadline_at < NOW()) AS breached_now,')}
         WHERE t.task_type = 'sla_first_response' AND t.status = 'open' AND t.deleted_at IS NULL
           AND t.sla_deadline_at IS NOT NULL
           AND ((t.sla_deadline_at < NOW() AND NOT t.sla_breached)
             OR (t.sla_deadline_at >= NOW() AND t.sla_deadline_at < NOW() + INTERVAL '4 hours'
                 AND t.sla_warned_at IS NULL))
         ORDER BY t.sla_deadline_at LIMIT ${BATCH}
         FOR UPDATE OF t SKIP LOCKED`,
        [],
      );
      let warned = 0;
      let breached = 0;
      for (const t of rows.rows) {
        const deadline = formatDateTime(t.sla_deadline_at ?? t.due_at, t.assignee_timezone);
        const target = taskTarget(t);
        if (t.breached_now) {
          await tx.query(
            `UPDATE tasks SET sla_breached = TRUE, sla_warned_at = COALESCE(sla_warned_at, NOW())
             WHERE id = $1`,
            [t.id],
          );
          const people = new Set([t.assignee_user_id, ...(await teamManagers(tx, t.team_id))]);
          for (const userId of people) {
            await addNotification(tx, {
              userId,
              kind: 'sla_breach',
              title: `Late reply${about(t)}`,
              body: `A website inquiry had no reply by ${deadline}.`,
              ...target,
              dedupeKey: `sla_breach:${t.id}:${userId}`,
            });
          }
          await this.db.addOutboxEvent(tx, {
            eventType: 'task.overdue',
            aggregateType: 'task',
            aggregateId: t.id,
            payload: { id: t.id, assigneeUserId: t.assignee_user_id, slaBreached: true },
          });
          breached += 1;
        } else {
          await tx.query(`UPDATE tasks SET sla_warned_at = NOW() WHERE id = $1`, [t.id]);
          if (
            await addNotification(tx, {
              userId: t.assignee_user_id,
              kind: 'sla_warning',
              title: `Reply due soon${about(t)}`,
              body: `Reply to this website inquiry by ${deadline}.`,
              ...target,
              dedupeKey: `sla_warning:${t.id}`,
            })
          ) {
            warned += 1;
          }
        }
      }
      return { warned, breached };
    });
  }

  /**
   * Idle deals (PRD 4.6): an open deal with no activity for longer than its stage's idle days
   * notifies its owner once per quiet spell. New activity moves `last_activity_at`, which
   * starts a new spell.
   */
  async flagIdleDeals(): Promise<{ idle: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{
        id: string;
        name: string;
        owner_user_id: string;
        stage_name: string;
        idle_days: number;
        last_activity_at: string;
        days: number;
      }>(
        `SELECT d.id, d.name, d.owner_user_id, d.stage_name, s.idle_days,
                d.last_activity_at::text AS last_activity_at,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - d.last_activity_at)) / 86400)::int AS days
         FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
         WHERE d.stage_category = 'open' AND d.deleted_at IS NULL
           AND d.last_activity_at < NOW() - make_interval(days => s.idle_days)
           AND (d.idle_flagged_at IS NULL OR d.idle_flagged_at < d.last_activity_at)
         ORDER BY d.last_activity_at LIMIT ${BATCH}
         FOR UPDATE OF d SKIP LOCKED`,
        [],
      );
      let idle = 0;
      for (const d of rows.rows) {
        await tx.query(`UPDATE deals SET idle_flagged_at = NOW() WHERE id = $1`, [d.id]);
        if (
          await addNotification(tx, {
            userId: d.owner_user_id,
            kind: 'deal_idle',
            title: `Idle for ${d.days} days: ${d.name}`,
            body: `Nothing has happened on this deal in ${d.stage_name} for ${d.days} days.`,
            entityType: 'deal',
            entityId: d.id,
            dedupeKey: `deal_idle:${d.id}:${epoch(d.last_activity_at)}`,
          })
        ) {
          idle += 1;
        }
      }
      return { idle };
    });
  }
}
