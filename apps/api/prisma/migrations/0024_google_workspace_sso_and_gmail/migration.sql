-- Migration 0024: Dual-provider Google Workspace OIDC Sign-In & Gmail API Mailbox Support (PRD §6.6, §8.2, §8.7, §15 Q2).
-- Expand-only migration compatible with previous releases.

-- 1. Link invited CRM users to their Google Workspace account (`sub` claim), mirroring `entra_object_id`.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_subject_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject_id
  ON users (google_subject_id)
  WHERE google_subject_id IS NOT NULL;

-- 2. Add Gmail incremental `historyId` cursor and explicit provider check on `mailbox_connections`.
ALTER TABLE mailbox_connections
  ADD COLUMN IF NOT EXISTS gmail_history_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_mailbox_connections_provider'
  ) THEN
    ALTER TABLE mailbox_connections
      ADD CONSTRAINT chk_mailbox_connections_provider
      CHECK (provider IN ('microsoft_graph', 'google_gmail'));
  END IF;
END $$;
