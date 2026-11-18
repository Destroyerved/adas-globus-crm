-- Milestone 3c: Deal stakeholder contacts (`deal_contacts`), recurring tasks (`recurrence_rule`,
-- `parent_task_id`), and FX rate defaults & grants (PRD 4.6, 4.7, 4.15, 4.17, 7.3).

-- 1. Deal stakeholder contacts (PRD 4.6, 7.3)
CREATE TABLE IF NOT EXISTS deal_contacts (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'Decision maker',
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_deal_id ON deal_contacts(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact_id ON deal_contacts(contact_id);

-- 2. Recurring tasks (PRD 4.7)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_rule_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_rule_check
  CHECK (
    recurrence_rule IS NULL
    OR recurrence_rule IN ('daily', 'business_days', 'weekly', 'biweekly', 'monthly')
  );

CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
  ON tasks(parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- 3. FX rates audit & baseline production rates (PRD 4.6, 4.15, 4.17)
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id);

INSERT INTO fx_rates (id, from_currency, to_currency, rate_scaled, effective_date)
VALUES
  ('fx_cad_usd_2026', 'CAD', 'USD', 740000, '2026-01-01'),
  ('fx_usd_cad_2026', 'USD', 'CAD', 1351351, '2026-01-01'),
  ('fx_usd_usd_2026', 'USD', 'USD', 1000000, '2026-01-01'),
  ('fx_cad_cad_2026', 'CAD', 'CAD', 1000000, '2026-01-01')
ON CONFLICT DO NOTHING;

-- 4. Least-privilege runtime grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deal_contacts TO adas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fx_rates TO adas_app;
