-- Milestone 5: Microsoft 365 & Microsoft Graph Inbox Integration (PRD 4.11, 7.3, 8.2, 8.3, 8.7, 9)
-- Expands `mailbox_connections`, `email_threads`, `email_messages`, and `templates`, and adds
-- `email_attachments` (metadata-only, streamed on demand) and `inbound_events` (webhook dedup).

-- 1. Mailbox connections: OAuth scopes, versioned AES-256-GCM tokens, Graph delta links,
--    webhook subscriptions, clientState hash, and per-mailbox Retry-After backoff (PRD 8.2).
ALTER TABLE mailbox_connections
  ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT 'openid profile email offline_access User.Read Mail.Read Mail.Send',
  ADD COLUMN IF NOT EXISTS encrypted_access_token TEXT,
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_key_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS inbox_delta_link TEXT,
  ADD COLUMN IF NOT EXISTS sent_delta_link TEXT,
  ADD COLUMN IF NOT EXISTS inbox_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS inbox_subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS sent_subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_state_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS sync_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retry_after_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_mailbox_connections_sync_due
  ON mailbox_connections(status, sync_pending, last_synced_at);
CREATE INDEX IF NOT EXISTS idx_mailbox_connections_inbox_sub
  ON mailbox_connections(inbox_subscription_id)
  WHERE inbox_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mailbox_connections_sent_sub
  ON mailbox_connections(sent_subscription_id)
  WHERE sent_subscription_id IS NOT NULL;

-- 2. Email threads: allow company-domain-matched threads before a contact exists (PRD 4.11),
--    group by Graph `conversationId` (PRD 8.2), link leads, and track unread count & snippet.
ALTER TABLE email_threads ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE email_threads
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snippet TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE email_threads t
SET snippet = COALESCE(
  (SELECT m.body_preview FROM email_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1),
  ''
)
WHERE t.snippet = '';

CREATE INDEX IF NOT EXISTS idx_email_threads_company
  ON email_threads(company_id, last_message_at DESC)
  WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_deal
  ON email_threads(deal_id, last_message_at DESC)
  WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_lead
  ON email_threads(lead_id, last_message_at DESC)
  WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_owner_last
  ON email_threads(owner_user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_owner_conv
  ON email_threads(owner_user_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- 3. Email messages: RFC 5322 headers for reply matching (`internet_message_id`, `in_reply_to`,
--    `references_header`), sanitised HTML, cc recipients, outbound status, and manual link origin.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS mailbox_connection_id TEXT REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS internet_message_id TEXT,
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT,
  ADD COLUMN IF NOT EXISTS references_header TEXT,
  ADD COLUMN IF NOT EXISTS body_html_sanitized TEXT,
  ADD COLUMN IF NOT EXISTS outbound_status TEXT NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS error_detail TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS linked_by TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_outbound_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_outbound_status_check
  CHECK (outbound_status IN ('queued', 'sent', 'failed'));

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_linked_by_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_linked_by_check
  CHECK (linked_by IN ('auto', 'user'));

CREATE INDEX IF NOT EXISTS idx_email_messages_internet_msg_id
  ON email_messages(internet_message_id)
  WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_mailbox
  ON email_messages(mailbox_connection_id)
  WHERE mailbox_connection_id IS NOT NULL;

-- Also add `internet_message_id` to `message_sends` for sequence reply header matching (PRD 7.3, 8.3)
ALTER TABLE message_sends
  ADD COLUMN IF NOT EXISTS internet_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_message_sends_internet_msg_id
  ON message_sends(internet_message_id)
  WHERE internet_message_id IS NOT NULL;

-- 4. Email attachment metadata (PRD 4.11, 7.3): file bytes are fetched on-demand from Graph.
CREATE TABLE IF NOT EXISTS email_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  mailbox_connection_id TEXT REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  provider_attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  is_inline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, provider_attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments(message_id);

-- 5. Templates: shared flag and optional HTML body for inbox/sequence/campaign reuse (PRD 4.11, 7.3).
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS body_html TEXT,
  ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT TRUE;

-- 6. Inbound webhook event deduplication (PRD 7.3, 7.6, 8.2, 8.4).
CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_events_received ON inbound_events(received_at DESC);

-- 7. Least-privilege runtime grants for `adas_app`.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_attachments TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inbound_events TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mailbox_connections TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_threads TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_messages TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE templates TO adas_app;
