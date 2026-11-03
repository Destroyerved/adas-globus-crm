-- ADAS CRM — Complete Schema Migration (PRD §7.2, §7.4, §9)
-- Includes extensions, partial unique indexes, trigram GIN indexes,
-- check constraints, and immutable audit_logs / suppressions guards.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
-- Phase 1: Teams, Roles, Capabilities, Users, Sessions, Audit Logs, Outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_capabilities (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('own', 'team', 'all', 'none')),
  PRIMARY KEY (role_id, capability)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  team_id TEXT REFERENCES teams(id),
  market_focus TEXT NOT NULL DEFAULT 'US' CHECK (market_focus IN ('US', 'CA', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  is_break_glass BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT,
  totp_secret TEXT,
  daily_send_cap INTEGER NOT NULL DEFAULT 50 CHECK (daily_send_cap >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(created_at ASC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Phase 2: Companies, Contacts, Leads, Compliance, Data Quality, Intake
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  firm_type TEXT NOT NULL DEFAULT 'CPA firm',
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  state_province TEXT,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  staff_band TEXT NOT NULL DEFAULT '11–20',
  account_status TEXT NOT NULL DEFAULT 'prospect' CHECK (account_status IN ('prospect', 'client', 'former_client', 'partner', 'do_not_contact')),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  accounting_software JSONB NOT NULL DEFAULT '[]'::jsonb,
  services_needed JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_revenue_minor BIGINT NOT NULL DEFAULT 0 CHECK (estimated_revenue_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'CAD')),
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_domain_active
  ON companies(domain)
  WHERE domain IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_name_trgm
  ON companies USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_companies_owner_user_id ON companies(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_team_id ON companies(team_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_market ON companies(market) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Partner',
  job_function TEXT NOT NULL DEFAULT 'Partner / Principal',
  seniority TEXT NOT NULL DEFAULT 'Partner',
  primary_email TEXT NOT NULL,
  phone_e164 TEXT,
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
  email_verification_status TEXT NOT NULL DEFAULT 'unknown' CHECK (email_verification_status IN ('unknown', 'valid', 'risky', 'invalid')),
  hard_bounced_at TIMESTAMPTZ,
  apollo_person_id TEXT,
  lead_score INTEGER NOT NULL DEFAULT 0,
  lead_score_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_primary_email_active
  ON contacts(primary_email)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_apollo_id_active
  ON contacts(apollo_person_id)
  WHERE apollo_person_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_full_name_trgm
  ON contacts USING GIN (full_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_owner_user_id ON contacts(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_team_id ON contacts(team_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contact_emails (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'unknown' CHECK (verification_status IN ('unknown', 'valid', 'risky', 'invalid')),
  hard_bounced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_emails_contact_id ON contact_emails(contact_id);

CREATE TABLE IF NOT EXISTS contact_phones (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  phone_label TEXT NOT NULL DEFAULT 'work',
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_phones_contact_id ON contact_phones(contact_id);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone_e164 TEXT,
  firm_name TEXT,
  domain TEXT,
  website TEXT,
  title TEXT NOT NULL DEFAULT 'Partner',
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  state_province TEXT,
  staff_band TEXT NOT NULL DEFAULT '11–20',
  source TEXT NOT NULL DEFAULT 'Manual entry',
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Researching', 'Contacted', 'Engaged', 'Qualified', 'Disqualified', 'Converted')),
  status_category TEXT NOT NULL DEFAULT 'open' CHECK (status_category IN ('open', 'qualified', 'closed')),
  disqualification_reason TEXT,
  services_needed JSONB NOT NULL DEFAULT '[]'::jsonb,
  software_stack JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  company_id TEXT REFERENCES companies(id),
  contact_id TEXT REFERENCES contacts(id),
  converted_deal_id TEXT,
  converted_at TIMESTAMPTZ,
  lead_score INTEGER NOT NULL DEFAULT 0,
  lead_score_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_email_active ON leads(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_owner_user_id ON leads(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_team_id ON leads(team_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_full_name_trgm ON leads USING GIN (full_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by_user_id TEXT REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_status_history_lead_id ON lead_status_history(lead_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color_tone TEXT NOT NULL DEFAULT 'neutral',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entity_tags (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_type, entity_id, tag_id)
);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'select', 'multi_select', 'boolean', 'date')),
  options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, field_key)
);

CREATE TABLE IF NOT EXISTS record_history (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  changed_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_history_entity ON record_history(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_field TEXT NOT NULL DEFAULT 'updated_at',
  sort_dir TEXT NOT NULL DEFAULT 'desc' CHECK (sort_dir IN ('asc', 'desc')),
  density TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'contact',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('dry_run', 'running', 'completed', 'rolled_back', 'failed')),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  duplicate_policy TEXT NOT NULL DEFAULT 'update_blank' CHECK (duplicate_policy IN ('skip', 'update_blank', 'overwrite')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate_count INTEGER NOT NULL DEFAULT 0,
  skipped_suppressed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  created_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_rows_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  left_entity_id TEXT NOT NULL,
  right_entity_id TEXT NOT NULL,
  match_reason TEXT NOT NULL,
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0.90,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS merge_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  survivor_id TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  email_sha256 TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual_dnc', 'privacy_erasure')),
  source TEXT NOT NULL,
  notes TEXT,
  actor_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS suppressed_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  market TEXT NOT NULL CHECK (market IN ('US', 'CA', 'OTHER')),
  basis TEXT NOT NULL CHECK (basis IN ('express', 'implied_inquiry', 'implied_ebr', 'implied_published', 'legitimate_interest_b2b')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  source TEXT NOT NULL,
  proof_text TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_records_email ON consent_records(email, created_at DESC);

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'sequence',
  source_id TEXT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Phase 3: Pipelines, Deals, Tasks, Activities, FX Rates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('open', 'won', 'lost')),
  probability INTEGER NOT NULL CHECK (probability BETWEEN 0 AND 100),
  stage_order INTEGER NOT NULL,
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pipeline_id, name)
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
  stage_name TEXT NOT NULL,
  stage_category TEXT NOT NULL DEFAULT 'open' CHECK (stage_category IN ('open', 'won', 'lost')),
  company_id TEXT NOT NULL REFERENCES companies(id),
  primary_contact_id TEXT REFERENCES contacts(id),
  name TEXT NOT NULL,
  monthly_value_minor BIGINT NOT NULL CHECK (monthly_value_minor >= 0),
  annual_value_minor BIGINT NOT NULL CHECK (annual_value_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'CAD')),
  fte_count NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  engagement_model TEXT NOT NULL DEFAULT 'Full-time',
  services JSONB NOT NULL DEFAULT '[]'::jsonb,
  probability INTEGER NOT NULL DEFAULT 10,
  expected_close_date TEXT,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  trial_candidate_role TEXT,
  trial_passed BOOLEAN,
  contract_start_date TEXT,
  lost_reason TEXT,
  lost_notes TEXT,
  won_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_company_id ON deals(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_owner_user_id ON deals(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_team_id ON deals(team_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_stage_name ON deals(stage_name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  changed_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'follow_up' CHECK (task_type IN ('call', 'email', 'follow_up', 'trial_checkin', 'sla_first_response')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  sla_deadline_at TIMESTAMPTZ,
  sla_breached BOOLEAN NOT NULL DEFAULT FALSE,
  assignee_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON tasks(assignee_user_id, due_at ASC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_deal_id ON tasks(deal_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_company_id ON activities(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities(contact_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS fx_rates (
  id TEXT PRIMARY KEY,
  from_currency TEXT NOT NULL CHECK (from_currency IN ('USD', 'CAD')),
  to_currency TEXT NOT NULL CHECK (to_currency IN ('USD', 'CAD')),
  rate_scaled BIGINT NOT NULL CHECK (rate_scaled > 0), -- scaled by 1_000_000 (e.g. 0.740000 = 740000)
  effective_date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_currency, to_currency, effective_date)
);

-- ---------------------------------------------------------------------------
-- Phase 4: Inbox & Microsoft 365
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mailbox_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'microsoft_graph',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'Needs Reconnect', 'disconnected')),
  encrypted_refresh_token TEXT,
  last_synced_at TIMESTAMPTZ,
  daily_send_cap INTEGER NOT NULL DEFAULT 50,
  sent_today_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_threads (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_threads_contact ON email_threads(contact_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_email TEXT NOT NULL,
  to_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL,
  body_preview TEXT NOT NULL,
  body_text TEXT NOT NULL,
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id, sent_at ASC);

-- ---------------------------------------------------------------------------
-- Phase 5a & 5b: Templates, Sequences, Campaigns, Lists, Message Sends
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'outreach',
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  daily_cap_per_mailbox INTEGER NOT NULL DEFAULT 50,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_business_days INTEGER NOT NULL DEFAULT 0,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sequence_id, step_order)
);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  current_step_order INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'replied', 'bounced', 'unsubscribed', 'completed', 'stopped_deal_won', 'stopped_suppressed')),
  stop_reason TEXT,
  next_send_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_seq_enrollments_contact ON sequence_enrollments(contact_id);
CREATE INDEX IF NOT EXISTS idx_seq_enrollments_email ON sequence_enrollments(email);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  list_type TEXT NOT NULL DEFAULT 'static' CHECK (list_type IN ('static', 'dynamic')),
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  member_count INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS list_members (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'CA', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sending', 'sent', 'paused_deliverability', 'cancelled')),
  list_id TEXT REFERENCES lists(id),
  approved_by_user_id TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  bounced_count INTEGER NOT NULL DEFAULT 0,
  complained_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed_count INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'skipped_compliance', 'bounced', 'complained', 'unsubscribed')),
  reason_code TEXT,
  sent_at TIMESTAMPTZ,
  UNIQUE (campaign_id, email)
);

CREATE TABLE IF NOT EXISTS message_sends (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('sequence', 'campaign', 'one_to_one', 'transactional')),
  recipient_email TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  sender_user_id TEXT REFERENCES users(id),
  sequence_enrollment_id TEXT REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  transport_provider TEXT NOT NULL DEFAULT 'mailpit',
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'bounced', 'complained')),
  compliance_reason_code TEXT NOT NULL DEFAULT 'OK',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_sends_recipient_sent ON message_sends(recipient_email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_sends_sender_sent ON message_sends(sender_user_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Phase 6: Integrations, Webhooks, API Tokens, Lead Scoring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  secret_hmac TEXT NOT NULL,
  event_types JSONB NOT NULL DEFAULT '["lead.created","deal.won"]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_status_code INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '["leads:read","deals:read"]'::jsonb,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scoring_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('fit', 'engagement', 'negative')),
  field_path TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('eq', 'in', 'gt', 'contains', 'isTrue')),
  target_value JSONB NOT NULL,
  points INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS apollo_credit_ledger (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  credits_used INTEGER NOT NULL CHECK (credits_used > 0),
  apollo_person_id TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- PRD §5.3, §7.4, §9: Append-Only Protection on audit_logs & suppressions
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    CREATE ROLE adas_app NOLOGIN;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO adas_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM adas_app;
REVOKE DELETE, TRUNCATE ON TABLE suppressions FROM adas_app;

CREATE OR REPLACE FUNCTION prevent_audit_logs_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'permission denied: audit_logs is append-only (UPDATE and DELETE are prohibited)'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_logs_mutation();

CREATE OR REPLACE FUNCTION prevent_suppressions_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'permission denied: suppressions cannot be deleted (PRD 5.3)'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_suppressions_no_delete ON suppressions;
CREATE TRIGGER trg_suppressions_no_delete
  BEFORE DELETE ON suppressions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_suppressions_deletion();
