-- 0010_list_indexes: indexes for list sorts that the large seed showed were sorting whole
-- tables (PRD 6.7, 12.2; docs/perf/query-plans-pglite.md; ADR 0011). Expand only.
--
-- Every list pages by (sort value, id), so each index holds the sort expression exactly as the
-- list query writes it, then the id. One index serves both directions.

-- Sort by name.
CREATE INDEX IF NOT EXISTS idx_leads_name_sort ON leads (full_name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_name_sort ON contacts (full_name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_name_sort ON companies (name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_name_sort ON deals (name, id) WHERE deleted_at IS NULL;

-- Sort by last contacted. A record never contacted sorts as the epoch, as in the list query.
CREATE INDEX IF NOT EXISTS idx_leads_last_contacted_sort
  ON leads ((COALESCE(last_contacted_at, 'epoch'::timestamptz)), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted_sort
  ON contacts ((COALESCE(last_contacted_at, 'epoch'::timestamptz)), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_last_contacted_sort
  ON companies ((COALESCE(last_contacted_at, 'epoch'::timestamptz)), id) WHERE deleted_at IS NULL;

-- Sort by created (leads already have idx_leads_created).
CREATE INDEX IF NOT EXISTS idx_contacts_created_sort ON contacts (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_created_sort ON companies (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_created_sort ON deals (created_at, id) WHERE deleted_at IS NULL;

-- Leads by status and by score.
CREATE INDEX IF NOT EXISTS idx_leads_status_sort ON leads (status, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_score_sort ON leads (lead_score, id) WHERE deleted_at IS NULL;

-- Deals by monthly value and by expected close date (blank dates sort last).
CREATE INDEX IF NOT EXISTS idx_deals_value_sort ON deals (monthly_value_minor, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_close_date_sort
  ON deals ((COALESCE(NULLIF(expected_close_date, ''), '9999-12-31')), id) WHERE deleted_at IS NULL;

-- Tasks by due date across every status, and done tasks by when they were completed.
CREATE INDEX IF NOT EXISTS idx_tasks_due_sort ON tasks (due_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_completed_sort
  ON tasks ((COALESCE(completed_at, 'epoch'::timestamptz)), id) WHERE deleted_at IS NULL;
