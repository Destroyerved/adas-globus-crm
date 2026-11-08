-- 0006_break_glass: emergency admin sign-in (PRD 6.6, 7.2 local_credentials, 9).
-- Expand only. The plain users.password_hash and users.totp_secret columns were never used
-- for sign-in (the old stub accepted any password); they are cleared here and dropped in a
-- later contract migration. Nothing reads them.

CREATE TABLE IF NOT EXISTS local_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Argon2id PHC string.
  password_hash TEXT NOT NULL,
  -- AES-256-GCM (platform/crypto SecretBox), bound to this user; never the plain secret.
  totp_secret_ciphertext TEXT NOT NULL,
  -- The last accepted 30-second step, so a code can't be used twice.
  totp_last_step BIGINT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_credentials TO adas_app;

UPDATE users SET password_hash = NULL, totp_secret = NULL
WHERE password_hash IS NOT NULL OR totp_secret IS NOT NULL;

-- Only accounts with credentials are emergency admins.
UPDATE users SET is_break_glass = FALSE
WHERE is_break_glass AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.user_id = users.id);
