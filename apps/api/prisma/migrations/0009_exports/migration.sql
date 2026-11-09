-- 0009_exports: CSV exports of a list view (PRD 2.3, 4.9, 6.9, 6.11). Expand only.

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('lead', 'contact', 'company', 'deal')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'building', 'ready', 'failed', 'expired')),
  -- The list view as the person asked for it: search text, sort and filter.
  request JSONB NOT NULL,
  -- Rows the view held when asked; the written count once ready.
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  processed_rows INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  background BOOLEAN NOT NULL DEFAULT FALSE,
  file_id TEXT REFERENCES files(id),
  -- The worker refreshes this while it works; a stale one means the worker stopped.
  heartbeat_at TIMESTAMPTZ,
  failure_reason TEXT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- The file is deleted after this time (7 days).
  expires_at TIMESTAMPTZ,
  CHECK (status <> 'ready' OR (file_id IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_exports_requested_by ON exports (requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exports_team ON exports (team_id);
CREATE INDEX IF NOT EXISTS idx_exports_file ON exports (file_id);
-- The worker's two sweeps: work waiting, and ready files past their date.
CREATE INDEX IF NOT EXISTS idx_exports_waiting ON exports (created_at)
  WHERE status IN ('queued', 'building');
CREATE INDEX IF NOT EXISTS idx_exports_expiring ON exports (expires_at)
  WHERE status = 'ready';

GRANT SELECT, INSERT, UPDATE ON TABLE exports TO adas_app;
