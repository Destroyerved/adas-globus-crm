-- 0007_imports: CSV and XLSX imports with mapping, dry run, row results and undo
-- (PRD 4.9, 6.11, 7.2). Expand only. The prototype `import_jobs` table is no longer written
-- and will be dropped in a later contract migration.

-- Uploaded and generated files (PRD 6.11): only metadata here, the bytes in file storage.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('import', 'export')),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL DEFAULT 'contact' CHECK (entity IN ('contact', 'company')),
  filename TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded', 'mapped', 'checking', 'checked', 'queued', 'running', 'completed', 'failed',
    'rolling_back', 'rolled_back')),
  -- Header row and row count, read at upload.
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  -- The first few rows, shown while the user maps columns.
  sample JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Counts of the last dry run and of the real run: created, updated, duplicate, skipped, error.
  dry_run_counts JSONB,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What undo did: removed, reverted, kept (edited since), companies removed and kept.
  undo_counts JSONB,
  processed_rows INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  -- The worker refreshes this while it works; a stale one means the worker stopped.
  heartbeat_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_import_batches_created_by ON import_batches (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_team ON import_batches (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_waiting ON import_batches (updated_at)
  WHERE status IN ('checking', 'queued', 'running', 'rolling_back');
CREATE INDEX IF NOT EXISTS idx_import_batches_file ON import_batches (file_id);

-- One row per file row and pass (dry run or real). `before` holds the values an update
-- replaced and `entity_version` the record's version right after this import touched it,
-- so undo can tell whether someone has edited the record since.
CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  dry_run BOOLEAN NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number >= 1),
  raw JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'updated', 'duplicate', 'skipped', 'error')),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  entity_id TEXT,
  entity_version INTEGER,
  before JSONB,
  created_company_id TEXT,
  -- The existing record this row's new record probably duplicates (queued for review).
  probable_of TEXT,
  -- Set by undo: removed (created record soft-deleted), reverted (update undone) or kept
  -- (someone edited or used the record since, so it was left alone and listed).
  undo_status TEXT CHECK (undo_status IN ('removed', 'reverted', 'kept')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, dry_run, row_number)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_status ON import_rows (batch_id, dry_run, status, row_number);

CREATE TABLE IF NOT EXISTS import_mapping_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('contact', 'company')),
  mapping JSONB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_mapping_templates_name
  ON import_mapping_templates (created_by, entity, LOWER(name));

-- Where each record came from (PRD 4.9: source and import batch).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_import_batch ON contacts (import_batch_id)
  WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_import_batch ON companies (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- How a field change happened (PRD 7.3 record_history.via). Earlier rows came from the UI or
-- the API; the default keeps the previous release working.
ALTER TABLE record_history ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'ui'
  CHECK (via IN ('ui', 'api', 'import', 'merge', 'system'));

-- Probable duplicates found by imports wait for review (PRD 4.9); one open entry per pair.
ALTER TABLE duplicate_candidates ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
ALTER TABLE duplicate_candidates ADD COLUMN IF NOT EXISTS resolved_by TEXT REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_duplicate_candidates_open_pair
  ON duplicate_candidates (entity_type, LEAST(left_entity_id, right_entity_id),
                           GREATEST(left_entity_id, right_entity_id))
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_open ON duplicate_candidates (entity_type, created_at DESC)
  WHERE status = 'open';

-- Probable-match lookups: same phone, same name within a company, similar company names.
CREATE INDEX IF NOT EXISTS idx_contacts_phone_active ON contacts (phone_e164)
  WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_name_company ON contacts (LOWER(first_name), LOWER(last_name), company_id)
  WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE files, import_batches, import_rows,
  import_mapping_templates TO adas_app;
