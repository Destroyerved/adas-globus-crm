-- Milestone 8: Worker heartbeats, outbox retry tracking, and backup run telemetry
-- (PRD 6.9, 10.5, 10.6, 11 Phase 1). Forward-only, expand-then-contract.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_outbox_events_status_created
  ON outbox_events (status, created_at DESC);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'draining', 'stopped')),
  active_jobs INTEGER NOT NULL DEFAULT 0
    CHECK (active_jobs >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_job_name TEXT,
  last_job_at TIMESTAMPTZ,
  last_outbox_dispatch_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last_seen
  ON worker_heartbeats (last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('pg_dump', 'wal_base', 'files_snapshot', 'restore_drill', 'pre_deploy')),
  status TEXT NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed')),
  artifact_key TEXT,
  size_bytes BIGINT
    CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 TEXT,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  offsite_synced BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_kind_completed
  ON backup_runs (kind, status, completed_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats, backup_runs TO adas_app;
  END IF;
END $$;
