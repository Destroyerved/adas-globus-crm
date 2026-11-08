-- 0005_worker: background jobs (PRD 4.6, 4.7, 4.10, 4.16, 6.9).
-- Expand only: new nullable or defaulted columns and indexes; nothing is dropped.
-- The pg-boss schema itself is installed by `pnpm db:migrate` through the pg-boss library
-- (apps/api/scripts/migrate.ts), as the admin role, with DML grants to adas_app.

-- A first-reply inquiry gets one warning four hours before its deadline (PRD 4.16).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sla_warned_at TIMESTAMPTZ;

-- Outbox retries back off: an event is retried only once available_at has passed.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (available_at, created_at)
  WHERE status = 'pending';

-- Sweeps read only the rows they may act on.
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_due ON tasks (due_at)
  WHERE status = 'open' AND deleted_at IS NULL AND overdue_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_sla_open ON tasks (sla_deadline_at)
  WHERE task_type = 'sla_first_response' AND status = 'open' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_open_activity ON deals (last_activity_at)
  WHERE stage_category = 'open' AND deleted_at IS NULL;

-- Housekeeping deletes by age.
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
