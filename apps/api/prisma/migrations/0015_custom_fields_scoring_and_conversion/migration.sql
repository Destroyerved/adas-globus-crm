-- Milestone 3b: Custom field definitions & JSONB GIN indexes, configurable lead/contact scoring
-- rules with seeded CPA defaults, and contact email/phone grants (PRD 4.3-4.5, 4.16, 4.17, 6.8).

-- 1. Custom field definitions (widen types to include 'money' and 'url', add archive & ordering)
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS custom_field_definitions_field_type_check;
ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_definitions_field_type_check
  CHECK (field_type IN ('text', 'number', 'select', 'multi_select', 'boolean', 'date', 'money', 'url'));

ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS custom_field_definitions_entity_type_check;
ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_definitions_entity_type_check
  CHECK (entity_type IN ('lead', 'contact', 'company', 'deal'));

CREATE INDEX IF NOT EXISTS idx_custom_field_defs_entity
  ON custom_field_definitions (entity_type, sort_order ASC, created_at ASC)
  WHERE archived_at IS NULL;

-- 2. Custom fields JSONB on leads and deals (companies and contacts already carry custom_fields)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_companies_custom_fields_gin
  ON companies USING GIN (custom_fields jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_custom_fields_gin
  ON contacts USING GIN (custom_fields jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_custom_fields_gin
  ON leads USING GIN (custom_fields jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_custom_fields_gin
  ON deals USING GIN (custom_fields jsonb_path_ops)
  WHERE deleted_at IS NULL;

-- 3. Scoring rules (PRD 4.5, 4.16 — never scores email opens)
ALTER TABLE scoring_rules ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE scoring_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO scoring_rules (id, name, category, field_path, operator, target_value, points, active)
VALUES
  ('scr_firm_size', 'CPA Firm 21–100 Staff ICP', 'fit', 'staffBand', 'in', '["21–50","51–100","51–200"]'::jsonb, 25, TRUE),
  ('scr_partner_title', 'Decision Maker (Partner / Director)', 'fit', 'title', 'contains', '"Partner"'::jsonb, 20, TRUE),
  ('scr_trial_source', 'Website 3-Day Free Trial Inquiry', 'engagement', 'source', 'contains', '"trial"'::jsonb, 35, TRUE),
  ('scr_tax_software', 'Tier-1 Tax Software (UltraTax / CCH / CaseWare)', 'fit', 'softwareStack', 'contains', '"UltraTax CS"'::jsonb, 15, TRUE),
  ('scr_eng_replied_call', 'Logged call or meeting activity', 'engagement', 'hasCallOrMeeting', 'isTrue', 'true'::jsonb, 20, TRUE),
  ('scr_neg_freemail_no_firm', 'Personal email without corporate domain', 'negative', 'missingDomain', 'isTrue', 'true'::jsonb, -10, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 4. Least-privilege runtime grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE custom_field_definitions TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scoring_rules TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contact_emails TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contact_phones TO adas_app;
