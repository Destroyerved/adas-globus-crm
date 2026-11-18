-- 0019_seq_enrollment_merge_index
-- Replaces the single-column partial unique index on sequence_enrollments(contact_id) with a
-- composite partial unique index on (sequence_id, contact_id) WHERE status IN ('active', 'paused')
-- so contact merges (PRD 4.9) can safely re-point historical cross-sequence enrollments while
-- OutreachService.enrollInSequence and checkSendable enforce the single-active-sequence rule
-- (PRD 4.12, 5.6, A17).

DROP INDEX IF EXISTS uq_seq_enrollments_active_contact;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seq_enrollments_active_pair
  ON sequence_enrollments(sequence_id, contact_id)
  WHERE status IN ('active', 'paused');
