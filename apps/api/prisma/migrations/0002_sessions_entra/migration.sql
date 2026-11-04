-- R3: real sessions and Microsoft Entra sign-in (PRD 6.6). Expand-only.

-- Idle timeout: when the session was last used.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

-- Links a CRM user to their Microsoft Entra account (object ID, the "oid" claim).
ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_object_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_object_id
  ON users (entra_object_id) WHERE entra_object_id IS NOT NULL;
