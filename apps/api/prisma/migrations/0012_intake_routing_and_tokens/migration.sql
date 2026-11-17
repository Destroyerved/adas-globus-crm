-- 0012_intake_routing_and_tokens: raw website inquiries table, configurable market routing
-- rules, public per-IP rate-limit events, and hashed unsubscribe tokens
-- (PRD 4.5, 4.10, 4.17, 4.18, 5.3, 8.6, 9). Expand only.

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('trial', 'contact', 'consultation')),
  market TEXT NOT NULL CHECK (market IN ('US', 'CA', 'OTHER')),
  email_sha256 TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_sha256 TEXT,
  user_agent TEXT,
  page_url TEXT,
  deduplicated BOOLEAN NOT NULL DEFAULT FALSE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  consent_record_id TEXT REFERENCES consent_records(id) ON DELETE SET NULL,
  sla_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_dedup_created
  ON inquiries (dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_id
  ON inquiries (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_contact
  ON inquiries (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_email_sha256
  ON inquiries (email_sha256);
CREATE INDEX IF NOT EXISTS idx_inquiries_lead
  ON inquiries (lead_id)
  WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_company
  ON inquiries (company_id)
  WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_consent
  ON inquiries (consent_record_id)
  WHERE consent_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_sla_task
  ON inquiries (sla_task_id)
  WHERE sla_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_assigned_user
  ON inquiries (assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

ALTER TABLE consent_records
  ADD COLUMN IF NOT EXISTS inquiry_id TEXT REFERENCES inquiries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_consent_records_inquiry
  ON consent_records (inquiry_id)
  WHERE inquiry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS routing_rules (
  market TEXT PRIMARY KEY CHECK (market IN ('US', 'CA', 'OTHER')),
  mode TEXT NOT NULL DEFAULT 'round_robin' CHECK (mode IN ('round_robin', 'named_owner')),
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_routing_rules_mode_target CHECK (
    (mode = 'round_robin')
    OR (mode = 'named_owner' AND owner_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_team
  ON routing_rules (team_id)
  WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routing_rules_owner
  ON routing_rules (owner_user_id)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routing_rules_last_assigned
  ON routing_rules (last_assigned_user_id)
  WHERE last_assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routing_rules_updated_by
  ON routing_rules (updated_by_user_id)
  WHERE updated_by_user_id IS NOT NULL;

INSERT INTO routing_rules (market, mode, team_id)
VALUES
  ('US', 'round_robin', (SELECT id FROM teams WHERE id = 'team_us')),
  ('CA', 'round_robin', (SELECT id FROM teams WHERE id = 'team_ca')),
  ('OTHER', 'round_robin', (SELECT id FROM teams WHERE id = 'team_us'))
ON CONFLICT (market) DO NOTHING;

CREATE TABLE IF NOT EXISTS public_rate_events (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  ip_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_rate_events_lookup
  ON public_rate_events (endpoint, ip_sha256, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_rate_events_created
  ON public_rate_events (created_at);

ALTER TABLE unsubscribe_tokens
  ADD COLUMN IF NOT EXISTS token_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unsubscribe_tokens_sha256
  ON unsubscribe_tokens (token_sha256)
  WHERE token_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_contact
  ON unsubscribe_tokens (contact_id)
  WHERE contact_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inquiries TO adas_app;
GRANT SELECT, INSERT, UPDATE ON TABLE routing_rules TO adas_app;
GRANT SELECT, INSERT, DELETE ON TABLE public_rate_events TO adas_app;
