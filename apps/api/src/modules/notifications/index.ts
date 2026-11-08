import { randomUUID } from 'node:crypto';
import type { SessionUser } from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';

/**
 * In-app notifications (PRD 4.16): assignments, task reminders, overdue tasks, SLA warnings,
 * idle deals, import results and break-glass sign-ins. Email delivery of notifications
 * needs the Microsoft 365 connector and comes later.
 */

export type NotificationKind =
  | 'assignment'
  | 'task_reminder'
  | 'task_overdue'
  | 'sla_warning'
  | 'sla_breach'
  | 'deal_idle'
  | 'import_finished'
  | 'export_ready'
  | 'security'
  | 'general';

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Unique key so a retried job never notifies twice. */
  dedupeKey?: string | null;
}

/** Adds a notification inside the caller's transaction. Returns false if it was a duplicate. */
export async function addNotification(tx: DbTx, input: NotificationInput): Promise<boolean> {
  const res = await tx.query(
    `INSERT INTO notifications (id, user_id, kind, title, body, entity_type, entity_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      `ntf_${randomUUID()}`,
      input.userId,
      input.kind,
      input.title.slice(0, 200),
      input.body.slice(0, 1000),
      input.entityType ?? null,
      input.entityId ?? null,
      input.dedupeKey ?? null,
    ],
  );
  return res.rowCount > 0;
}

export class NotificationService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    user: SessionUser,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<{ items: Record<string, unknown>[]; unreadCount: number }> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const [items, unread] = await Promise.all([
      this.db.query(
        `SELECT id, kind, title, body, entity_type, entity_id, read_at, created_at
         FROM notifications
         WHERE user_id = $1 ${options.unreadOnly ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC
         LIMIT ${limit}`,
        [user.id],
      ),
      this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
        [user.id],
      ),
    ]);
    return { items: items.rows, unreadCount: unread.rows[0]?.n ?? 0 };
  }

  /** Marks one notification (or all, when id is null) as read. Only the owner's own. */
  async markRead(user: SessionUser, id: string | null): Promise<{ updated: number }> {
    const res = id
      ? await this.db.query(
          `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
          [id, user.id],
        )
      : await this.db.query(
          `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
          [user.id],
        );
    return { updated: res.rowCount };
  }
}
