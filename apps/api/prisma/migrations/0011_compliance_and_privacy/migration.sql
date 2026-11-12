-- 0011_compliance_and_privacy: suppression lifting with audit trail, permanent privacy_erasure
-- guard, consent record metadata and keyset/search indexes (PRD 4.17, 4.18, 5.3, 5.6, 7.4).
-- Expand only.

ALTER TABLE suppressions
  ADD COLUMN IF NOT EXISTS lifted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifted_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS lifted_reason TEXT;

UPDATE suppressions
SET email = NULL, lifted_at = NULL, lifted_by = NULL, lifted_reason = NULL
WHERE reason = 'privacy_erasure' AND (email IS NOT NULL OR lifted_at IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_suppressions_privacy_erasure_permanent'
  ) THEN
    ALTER TABLE suppressions
      ADD CONSTRAINT chk_suppressions_privacy_erasure_permanent
      CHECK (reason <> 'privacy_erasure' OR (email IS NULL AND lifted_at IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_suppressions_lift_requires_reason'
  ) THEN
    ALTER TABLE suppressions
      ADD CONSTRAINT chk_suppressions_lift_requires_reason
      CHECK (
        lifted_at IS NULL
        OR (
          lifted_by IS NOT NULL
          AND lifted_reason IS NOT NULL
          AND length(btrim(lifted_reason)) > 0
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION prevent_privacy_erasure_reversal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.reason = 'privacy_erasure' AND (
    NEW.reason <> 'privacy_erasure'
    OR NEW.email IS NOT NULL
    OR NEW.lifted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'permission denied: privacy_erasure suppressions are permanent and cannot be lifted or unmasked (PRD 4.18)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_suppressions_privacy_erasure_immutable ON suppressions;
CREATE TRIGGER trg_suppressions_privacy_erasure_immutable
  BEFORE UPDATE ON suppressions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_privacy_erasure_reversal();

CREATE INDEX IF NOT EXISTS idx_suppressions_created_id
  ON suppressions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_suppressions_active_created
  ON suppressions (created_at DESC, id DESC)
  WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_email_trgm
  ON suppressions USING GIN (email gin_trgm_ops)
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_actor
  ON suppressions (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_lifted_by
  ON suppressions (lifted_by)
  WHERE lifted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suppressed_domains_created
  ON suppressed_domains (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_suppressed_domains_actor
  ON suppressed_domains (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

ALTER TABLE consent_records
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'marketing'
    CHECK (purpose IN ('marketing', 'outreach')),
  ADD COLUMN IF NOT EXISTS recorded_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_consent_records_contact
  ON consent_records (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_records_recorded_by
  ON consent_records (recorded_by_user_id)
  WHERE recorded_by_user_id IS NOT NULL;
