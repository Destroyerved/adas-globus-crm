-- M1: fast lists, record editing, timelines and system reference data.
-- PRD 3.3, 3.4, 4.3-4.7, 6.7, 6.8, 6.10. Expand-only: nothing is dropped or renamed except
-- the tasks.task_type check, which is widened.

-- ---------------------------------------------------------------------------
-- Keyset pagination and search indexes (PRD 6.7, 6.10, 12.2)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_email_trgm ON leads USING GIN (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_firm_name_trgm ON leads USING GIN (firm_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_company_id ON leads (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads (contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_email_trgm ON contacts USING GIN (primary_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_domain_trgm ON companies USING GIN (domain gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_name_trgm ON deals USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_deals_stage_id ON deals (stage_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_primary_contact ON deals (primary_contact_id) WHERE primary_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id ON tasks (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks (company_id) WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_activities_lead_id ON activities (lead_id, occurred_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities (deal_id, occurred_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_deal ON deal_stage_history (deal_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

-- "Today" and "Overdue" are calculated in the assignee's time zone (PRD 4.7).
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- Who has been contacted recently, so two people don't prospect the same firm (PRD 2.3, 4.5).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Task reminders, outcomes and the full task type list (PRD 4.7).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by_user_id TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_type_check CHECK (task_type IN (
  'call', 'email', 'follow_up', 'meeting', 'research', 'trial_checkin', 'proposal', 'internal',
  'sla_first_response'
));
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_due ON tasks (reminder_at)
  WHERE reminder_at IS NOT NULL AND reminder_sent_at IS NULL AND status = 'open' AND deleted_at IS NULL;

-- Notes keep their edit history (PRD 3.1).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE notes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Contract value, close date, FX at close and idle tracking (PRD 4.6, 14).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS term_months INTEGER NOT NULL DEFAULT 12 CHECK (term_months > 0);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS one_time_value_minor BIGINT NOT NULL DEFAULT 0 CHECK (one_time_value_minor >= 0);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS probability_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS fx_rate_scaled_at_close BIGINT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE deals ADD COLUMN IF NOT EXISTS idle_flagged_at TIMESTAMPTZ;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS idle_days INTEGER NOT NULL DEFAULT 14 CHECK (idle_days > 0);
UPDATE deals SET closed_at = COALESCE(won_at, lost_at) WHERE closed_at IS NULL AND stage_category <> 'open';
CREATE INDEX IF NOT EXISTS idx_deals_closed_at ON deals (closed_at) WHERE closed_at IS NOT NULL AND deleted_at IS NULL;

-- Notifications: a type, so the bell can group and the worker can dedupe.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- System reference data needed in every environment (PRD 2.1, 3.3, 3.4).
-- Synthetic people and records stay in the seed script; this is configuration.
-- ---------------------------------------------------------------------------
INSERT INTO roles (id, name, description, is_system) VALUES
  ('role_admin', 'Admin', 'Full system administration and compliance control', TRUE),
  ('role_sales_mgr', 'Sales Manager', 'Manages team pipeline, sequences, and conversions', TRUE),
  ('role_bdr', 'BDR / SDR', 'Qualifies leads and runs outbound sequences', TRUE),
  ('role_ae', 'Account Executive', 'Manages deals, 3-day free trials, and closing', TRUE),
  ('role_mkt_mgr', 'Marketing Manager', 'Approves campaigns, manages segments and compliance', TRUE),
  ('role_analyst', 'Read-Only / Analyst', 'Read-only reporting and audit analyst', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pipelines (id, name, is_default) VALUES
  ('pipeline_new_business', 'New Business', TRUE),
  ('pipeline_expansion', 'Client Expansion', FALSE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pipeline_stages (id, pipeline_id, name, category, probability, stage_order, required_fields) VALUES
  ('stg_new', 'pipeline_new_business', 'New Opportunity', 'open', 10, 1, '[]'::jsonb),
  ('stg_disc', 'pipeline_new_business', 'Discovery Scheduled', 'open', 25, 2, '[]'::jsonb),
  ('stg_trial', 'pipeline_new_business', 'Free Trial (3-Day)', 'open', 50, 3, '["trial_candidate_role"]'::jsonb),
  ('stg_prop', 'pipeline_new_business', 'Proposal Sent', 'open', 70, 4, '[]'::jsonb),
  ('stg_neg', 'pipeline_new_business', 'Negotiation / MSA', 'open', 85, 5, '[]'::jsonb),
  ('stg_won', 'pipeline_new_business', 'Won', 'won', 100, 6, '["contract_start_date"]'::jsonb),
  ('stg_lost', 'pipeline_new_business', 'Lost', 'lost', 0, 7, '["lost_reason"]'::jsonb),
  ('stg_exp_ident', 'pipeline_expansion', 'Identified', 'open', 20, 1, '[]'::jsonb),
  ('stg_exp_prop', 'pipeline_expansion', 'Proposal Sent', 'open', 60, 2, '[]'::jsonb),
  ('stg_exp_neg', 'pipeline_expansion', 'Negotiation / MSA', 'open', 80, 3, '[]'::jsonb),
  ('stg_exp_won', 'pipeline_expansion', 'Won', 'won', 100, 4, '["contract_start_date"]'::jsonb),
  ('stg_exp_lost', 'pipeline_expansion', 'Lost', 'lost', 0, 5, '["lost_reason"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings (key, value_json) VALUES
  ('reference.services', '["Accounting and bookkeeping","Tax preparation and review","Audit support","Payroll, AP and AR","Dedicated professionals","Full back-office suite"]'::jsonb),
  ('reference.engagement_models', '["Part-time","Full-time","Seasonal","Dedicated team","Project"]'::jsonb),
  ('reference.firm_types', '["CPA firm","Tax practice (EA)","Bookkeeping firm","Audit firm","Business (direct)","Other"]'::jsonb),
  ('reference.staff_bands', '["1–5","6–20","21–50","51–200","201+"]'::jsonb),
  ('reference.software', '["QuickBooks","Xero","Sage","NetSuite","Drake Tax","ProSeries","ProConnect","Lacerte","UltraTax CS","CCH Axcess","CaseWare","Gusto","ADP","Paychex","Bill.com","Dext","SafeSend","Suralink"]'::jsonb),
  ('reference.lead_sources', '["Website: trial form","Website: contact form","Apollo","LinkedIn (manual research)","Referral","Event","Import","Bigin (legacy)","Manual"]'::jsonb),
  ('reference.lost_reasons', '["Price","Chose another provider","Hiring locally or in-house","Data security concerns","Trial outcome","Timing","No response","Other"]'::jsonb),
  ('reference.disqualify_reasons', '["Not a fit (size or type)","No outsourcing need","Existing client","Competitor","Bad data","Asked not to be contacted","Other"]'::jsonb),
  ('reference.deal_contact_roles', '["Decision maker","Influencer","Reviewer","Day-to-day contact","Billing"]'::jsonb),
  ('sla.first_response_business_days', '1'::jsonb),
  ('deals.idle_days_default', '14'::jsonb)
ON CONFLICT (key) DO NOTHING;
