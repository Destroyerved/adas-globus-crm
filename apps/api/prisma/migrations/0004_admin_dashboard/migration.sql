-- M1: administration (users, teams, roles, pipelines, reference lists, audit log viewer)
-- and the role dashboard. PRD 2.1, 2.2, 3.3, 4.2, 4.16, 4.17, 14.
-- Expand-only: new columns are nullable or defaulted, and nothing is dropped or renamed.

-- Optimistic versions for records admins edit (AGENTS.md section 7).
ALTER TABLE users ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE settings ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The trial stage is a flag, not a stage name, so admins can rename stages safely (PRD 3.3).
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS is_trial BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE pipeline_stages SET is_trial = TRUE
  WHERE id = 'stg_trial' OR (name = 'Free Trial (3-Day)' AND is_trial = FALSE);

-- Stage history by stage ID as well as name, so renamed stages still count in
-- trial-to-win and stage reports (PRD 14). Backfilled from names within the deal's pipeline.
ALTER TABLE deal_stage_history ADD COLUMN IF NOT EXISTS from_stage_id TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL;
ALTER TABLE deal_stage_history ADD COLUMN IF NOT EXISTS to_stage_id TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL;
UPDATE deal_stage_history h SET from_stage_id = s.id
  FROM deals d JOIN pipeline_stages s ON s.pipeline_id = d.pipeline_id
  WHERE d.id = h.deal_id AND s.name = h.from_stage AND h.from_stage_id IS NULL;
UPDATE deal_stage_history h SET to_stage_id = s.id
  FROM deals d JOIN pipeline_stages s ON s.pipeline_id = d.pipeline_id
  WHERE d.id = h.deal_id AND s.name = h.to_stage AND h.to_stage_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_from_stage ON deal_stage_history (from_stage_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_to_stage ON deal_stage_history (to_stage_id);
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_actor ON deal_stage_history (changed_by_user_id, created_at);

-- Audit log viewer filters (PRD 4.17).
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC, id DESC);

-- Dashboard metric paths (PRD 14).
CREATE INDEX IF NOT EXISTS idx_tasks_sla ON tasks (sla_deadline_at)
  WHERE task_type = 'sla_first_response' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_completed_by ON tasks (completed_by_user_id, completed_at)
  WHERE completed_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_leads_source_created ON leads (created_at, source) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_message_sends_sent_at ON message_sends (sent_at);
CREATE INDEX IF NOT EXISTS idx_suppressions_created_at ON suppressions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_capabilities_role ON role_capabilities (role_id);
