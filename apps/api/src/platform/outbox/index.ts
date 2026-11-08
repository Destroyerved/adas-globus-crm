import { type Logger } from 'pino';
import { type DatabaseService, type DbTx } from '../db/index.js';

/**
 * Outbox dispatch (PRD 6.9). Business changes write their events to `outbox_events` in the
 * same transaction; this dispatcher hands each pending event to the handlers registered for
 * its type. Each event is processed in its own transaction together with the handlers'
 * writes, so an event is marked processed exactly when its effects commit. A failing event
 * is retried with exponential backoff and moved to `dead_letter` after `maxAttempts`.
 * Handlers must be idempotent: a crash between the effect and the commit retries the event.
 */

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: string;
}

export type OutboxHandler = (event: OutboxEvent, tx: DbTx) => Promise<void>;

export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly maxAttempts = 10,
  ) {}

  /** Registers a handler for one event type, or '*' for every event. */
  on(eventType: string, handler: OutboxHandler): this {
    this.handlers.set(eventType, [...(this.handlers.get(eventType) ?? []), handler]);
    return this;
  }

  async dispatch(
    limit = 100,
  ): Promise<{ processed: number; retried: number; deadLettered: number }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM outbox_events
       WHERE status = 'pending' AND available_at <= NOW()
       ORDER BY created_at, id LIMIT $1`,
      [limit],
    );
    const result = { processed: 0, retried: 0, deadLettered: 0 };
    for (const { id } of due.rows) {
      try {
        const done = await this.db.transaction(async (tx) => {
          // SKIP LOCKED: a second worker never handles the same event at the same time.
          const row = await tx.query<{
            id: string;
            event_type: string;
            aggregate_type: string;
            aggregate_id: string;
            payload: Record<string, unknown>;
            attempts: number;
            created_at: string;
          }>(
            `SELECT id, event_type, aggregate_type, aggregate_id, payload, attempts,
                    created_at::text AS created_at
             FROM outbox_events WHERE id = $1 AND status = 'pending'
             FOR UPDATE SKIP LOCKED`,
            [id],
          );
          const e = row.rows[0];
          if (!e) return false;
          const event: OutboxEvent = {
            id: e.id,
            eventType: e.event_type,
            aggregateType: e.aggregate_type,
            aggregateId: e.aggregate_id,
            payload: e.payload ?? {},
            attempts: e.attempts,
            createdAt: e.created_at,
          };
          for (const handler of [
            ...(this.handlers.get(event.eventType) ?? []),
            ...(this.handlers.get('*') ?? []),
          ]) {
            await handler(event, tx);
          }
          await tx.query(
            `UPDATE outbox_events SET status = 'processed', processed_at = NOW(),
               attempts = attempts + 1, last_error = NULL
             WHERE id = $1`,
            [id],
          );
          return true;
        });
        if (done) result.processed += 1;
      } catch (err) {
        // Only the error class and code are stored: messages can carry personal data.
        const code = (err as { code?: string }).code;
        const reason = `${(err as Error).name ?? 'Error'}${code ? ` ${code}` : ''}`;
        const res = await this.db.query<{ status: string }>(
          `UPDATE outbox_events
           SET attempts = attempts + 1, last_error = $2,
               status = CASE WHEN attempts + 1 >= $3 THEN 'dead_letter' ELSE 'pending' END,
               available_at = NOW() + make_interval(secs => LEAST(3600, POWER(2, attempts + 1)))
           WHERE id = $1 AND status = 'pending'
           RETURNING status`,
          [id, reason, this.maxAttempts],
        );
        if (res.rows[0]?.status === 'dead_letter') {
          result.deadLettered += 1;
          this.logger.error({ eventId: id, reason }, 'outbox event moved to dead letter');
        } else {
          result.retried += 1;
          this.logger.warn({ eventId: id, reason }, 'outbox event failed; will retry');
        }
      }
    }
    return result;
  }
}
