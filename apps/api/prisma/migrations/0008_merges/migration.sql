-- 0008: duplicate review and merge with undo (PRD 4.9, 7.3; ADR 0009).
-- Expand only: new nullable columns, a widened check constraint and indexes. The previous
-- release keeps working against this schema.

-- merge_logs is the PRD's merge_snapshots table. It keeps its name so the running release
-- keeps working; the snapshot now holds everything needed to undo a merge.
ALTER TABLE merge_logs ADD COLUMN IF NOT EXISTS duplicate_candidate_id TEXT REFERENCES duplicate_candidates(id);
ALTER TABLE merge_logs ADD COLUMN IF NOT EXISTS undone_by TEXT REFERENCES users(id);
ALTER TABLE merge_logs ADD COLUMN IF NOT EXISTS undo_result JSONB;
CREATE INDEX IF NOT EXISTS idx_merge_logs_recent ON merge_logs (entity_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_logs_survivor ON merge_logs (survivor_id);
CREATE INDEX IF NOT EXISTS idx_merge_logs_merged ON merge_logs (merged_id);
CREATE INDEX IF NOT EXISTS idx_merge_logs_actor ON merge_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_merge_logs_candidate ON merge_logs (duplicate_candidate_id)
  WHERE duplicate_candidate_id IS NOT NULL;

-- The queue looks up every pair a record is part of (to re-point them on merge), and a
-- dismissed pair is never queued again.
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_left ON duplicate_candidates (entity_type, left_entity_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_right ON duplicate_candidates (entity_type, right_entity_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_resolved_by ON duplicate_candidates (resolved_by)
  WHERE resolved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_pair
  ON duplicate_candidates (entity_type, LEAST(left_entity_id, right_entity_id),
                           GREATEST(left_entity_id, right_entity_id));

-- When both contacts were in the same sequence, the merged contact's enrollment stops so the
-- kept contact isn't emailed twice. Undo puts it back as paused, never straight to sending.
ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_status_check;
ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_status_check
  CHECK (status IN ('active', 'paused', 'replied', 'bounced', 'unsubscribed', 'completed',
                    'stopped_deal_won', 'stopped_suppressed', 'stopped_merged'));

-- Foreign keys a merge re-points that had no index yet (AGENTS.md 8).
CREATE INDEX IF NOT EXISTS idx_email_threads_company ON email_threads (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_records_contact ON consent_records (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_sends_contact ON message_sends (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_contact ON unsubscribe_tokens (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_contact ON campaign_recipients (contact_id);
CREATE INDEX IF NOT EXISTS idx_list_members_contact ON list_members (contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_phones_phone ON contact_phones (phone_e164);
