-- 0020_seq_enrollment_merged_status
-- Preserves `stopped_merged` (introduced in 0008_merges) alongside the expanded sequence stop
-- statuses from 0018_sequences_campaigns_esp_and_clicks so contact merges cleanly stop duplicate
-- enrollments on the same sequence (PRD 4.9, 4.12).

ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_status_check;
ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_status_check
  CHECK (status IN (
    'active',
    'paused',
    'replied',
    'bounced',
    'unsubscribed',
    'completed',
    'stopped_deal_won',
    'stopped_suppressed',
    'stopped_merged',
    'stopped_manual',
    'stopped_mailbox',
    'stopped_meeting'
  ));
