-- Milestone 3a: Saved views (team sharing, URL params, column chooser, version) and bulk action
-- jobs (PRD 4.5, 4.6, 4.8, 6.7, 6.9, 9). Forward-only expand migration.

ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS params_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS sort_spec TEXT NOT NULL DEFAULT '-updatedAt';
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS columns_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS saved_views_entity_type_check;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_entity_type_check
  CHECK (entity_type IN ('lead', 'contact', 'company', 'deal'));

CREATE INDEX IF NOT EXISTS idx_saved_views_owner_entity
  ON saved_views (entity_type, owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_saved_views_shared_entity
  ON saved_views (entity_type, team_id, created_at DESC)
  WHERE is_shared = TRUE;

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('lead', 'contact', 'company', 'deal')),
  action TEXT NOT NULL CHECK (action IN ('assign', 'status', 'add_tag', 'remove_tag', 'delete')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  background BOOLEAN NOT NULL DEFAULT FALSE,
  selection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  processed_rows INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  succeeded_rows INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_rows >= 0),
  skipped_rows INTEGER NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  failure_reason TEXT,
  heartbeat_at TIMESTAMPTZ,
  requested_by TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_waiting
  ON bulk_jobs (created_at ASC)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_requester
  ON bulk_jobs (requested_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_team
  ON bulk_jobs (team_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE saved_views TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bulk_jobs TO adas_app;
