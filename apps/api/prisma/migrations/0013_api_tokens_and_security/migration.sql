-- 0013_api_tokens_and_security: scoped service API tokens with capability ceiling, expiry,
-- usage tracking and indexes (PRD 4.14, 6.7, 9). Expand only.

ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS scope_level TEXT NOT NULL DEFAULT 'team'
    CHECK (scope_level IN ('own', 'team', 'all')),
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '["leads.read","deals.read"]'::jsonb,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_ip TEXT,
  ADD COLUMN IF NOT EXISTS last_audited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_tokens_creator
  ON api_tokens (created_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_tokens_active_hash
  ON api_tokens (token_sha256)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE api_tokens TO adas_app;
