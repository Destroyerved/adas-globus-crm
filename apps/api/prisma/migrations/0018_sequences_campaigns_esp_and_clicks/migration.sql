-- Milestone 6: Sequences, Campaigns, ESP Bulk Sender, Send Events & Stored Click Redirects
-- (PRD 4.12, 4.13, 5.1–5.6, 7.3, 7.4, 8.3–8.7, 12.1 A12, A15–A20).

-- 1. Templates: explicit channel, block-editor JSON, team scope, and optimistic concurrency version.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sequence',
  ADD COLUMN IF NOT EXISTS blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

UPDATE templates
SET channel = CASE
  WHEN category IN ('sequence', 'campaign', 'inbox') THEN category
  ELSE 'sequence'
END
WHERE channel = 'sequence' AND category IN ('campaign', 'inbox');

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_channel_check;
ALTER TABLE templates ADD CONSTRAINT templates_channel_check
  CHECK (channel IN ('sequence', 'campaign', 'inbox'));

CREATE INDEX IF NOT EXISTS idx_templates_channel_owner
  ON templates(channel, owner_user_id);

-- 2. Sequences, steps (email & task steps + reply-in-thread), and enrollments (partial unique active contact).
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS send_window_start_minutes INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN IF NOT EXISTS send_window_end_minutes INTEGER NOT NULL DEFAULT 1020,
  ADD COLUMN IF NOT EXISTS stop_on_company_reply BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS click_tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sequence_steps
  ALTER COLUMN subject_template SET DEFAULT '',
  ALTER COLUMN body_template SET DEFAULT '';

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS step_kind TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS reply_in_thread BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'follow_up',
  ADD COLUMN IF NOT EXISTS task_title TEXT,
  ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;

ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_step_kind_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_step_kind_check
  CHECK (step_kind IN ('email', 'task'));

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS mailbox_connection_id TEXT REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enrolled_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS last_step_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_skip_reason TEXT;

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
    'stopped_manual',
    'stopped_mailbox',
    'stopped_meeting'
  ));

-- PRD 5.6, 7.3 & A17: at most one active sequence per contact across all sequences.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seq_enrollments_active_contact
  ON sequence_enrollments(contact_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_seq_enrollments_due
  ON sequence_enrollments(status, next_send_at)
  WHERE status = 'active' AND next_send_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seq_enrollments_sequence_status
  ON sequence_enrollments(sequence_id, status);

-- 3. Static lists & dynamic segments (PRD 4.13, 6.8).
ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE list_members
  ADD COLUMN IF NOT EXISTS added_by_user_id TEXT REFERENCES users(id);

-- 4. Verified sender identities & sending subdomain warm-up caps (PRD 5.4, 7.3).
CREATE TABLE IF NOT EXISTS sender_identities (
  id TEXT PRIMARY KEY,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL UNIQUE,
  reply_to_email TEXT,
  domain TEXT NOT NULL,
  spf_verified BOOLEAN NOT NULL DEFAULT FALSE,
  dkim_verified BOOLEAN NOT NULL DEFAULT FALSE,
  dmarc_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  daily_warmup_cap INTEGER NOT NULL DEFAULT 250 CHECK (daily_warmup_cap > 0),
  sent_today_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_today_count >= 0),
  owner_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sender_identities_domain ON sender_identities(domain);

-- 5. Campaigns & campaign_recipients expansion (PRD 4.13, 5.6, 7.3, 8.4).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS body_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS blocks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS segment_filter_json JSONB,
  ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sender_identity_id TEXT REFERENCES sender_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS throttle_per_hour INTEGER NOT NULL DEFAULT 200 CHECK (throttle_per_hour > 0),
  ADD COLUMN IF NOT EXISTS respect_recipient_timezone BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS click_tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS exclude_unverified BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS soft_bounced_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicked_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opened_unreliable_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN (
    'draft',
    'pending_approval',
    'approved',
    'scheduled',
    'sending',
    'paused',
    'paused_deliverability',
    'completed',
    'sent',
    'cancelled'
  ));

CREATE INDEX IF NOT EXISTS idx_campaigns_status_sched
  ON campaigns(status, scheduled_at);

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS message_send_id TEXT REFERENCES message_sends(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;
ALTER TABLE campaign_recipients ADD CONSTRAINT campaign_recipients_status_check
  CHECK (status IN (
    'queued',
    'sent',
    'delivered',
    'skipped_compliance',
    'bounced',
    'soft_bounced',
    'complained',
    'unsubscribed',
    'failed'
  ));

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_queue
  ON campaign_recipients(campaign_id, status);

-- 6. Message sends, send_events & stored-URL click_tokens (PRD 7.3, 8.3–8.6).
ALTER TABLE message_sends
  ADD COLUMN IF NOT EXISTS sequence_step_id TEXT REFERENCES sequence_steps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_recipient_id TEXT REFERENCES campaign_recipients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sender_identity_id TEXT REFERENCES sender_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS body_html TEXT,
  ADD COLUMN IF NOT EXISTS error_detail TEXT;

ALTER TABLE message_sends DROP CONSTRAINT IF EXISTS message_sends_status_check;
ALTER TABLE message_sends ADD CONSTRAINT message_sends_status_check
  CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'soft_bounced', 'complained', 'failed', 'skipped'));

CREATE INDEX IF NOT EXISTS idx_message_sends_provider_msg
  ON message_sends(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_sends_campaign
  ON message_sends(campaign_id, status)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_sends_enrollment
  ON message_sends(sequence_enrollment_id, sequence_step_id)
  WHERE sequence_enrollment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_sends_contact_sent
  ON message_sends(contact_id, sent_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_events (
  id TEXT PRIMARY KEY,
  message_send_id TEXT REFERENCES message_sends(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  sequence_enrollment_id TEXT REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'delivered',
    'bounced_hard',
    'bounced_soft',
    'complained',
    'clicked',
    'opened',
    'replied',
    'unsubscribed'
  )),
  provider TEXT NOT NULL DEFAULT 'esp_bulk',
  provider_event_id TEXT,
  link_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_send_events_send_id ON send_events(message_send_id, event_type);
CREATE INDEX IF NOT EXISTS idx_send_events_campaign_id ON send_events(campaign_id, event_type);

-- PRD 8.6: Click redirect `/c/:token` looks up the hashed token and redirects ONLY to `target_url`
-- stored here (never an open redirect).
CREATE TABLE IF NOT EXISTS click_tokens (
  token_sha256 TEXT PRIMARY KEY,
  target_url TEXT NOT NULL CHECK (target_url ~* '^https?://'),
  message_send_id TEXT REFERENCES message_sends(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  sequence_enrollment_id TEXT REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  first_clicked_at TIMESTAMPTZ,
  last_clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_click_tokens_campaign ON click_tokens(campaign_id);
CREATE INDEX IF NOT EXISTS idx_click_tokens_send ON click_tokens(message_send_id);

-- 7. Least-privilege runtime grants for `adas_app`.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sender_identities TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE send_events TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE click_tokens TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sequences TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sequence_steps TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sequence_enrollments TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE lists TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE list_members TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE campaigns TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE campaign_recipients TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE message_sends TO adas_app;
